// Serein Voice: the phone side of Serein's read-only message bridge.
//
// The computer runs Serein with "Phone bridge" enabled and shows a port and token.
// This app connects to ws://<computer>:<port>/?token=<token>, lists one row per server
// channel or friend, and shows the messages that arrive for the selected row.

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ActivityIndicator,
	AppState,
	FlatList,
	Keyboard,
	KeyboardAvoidingView,
	Pressable,
	RefreshControl,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native';

type Channel = {
	id: string;
	kind: number;
	name: string;
	guild: string | null;
	voice: boolean;
};

type Message = {
	id: string;
	channel: string;
	author: string;
	content: string;
	edited: boolean;
};

type Frame =
	| { type: 'channel'; channel: Channel }
	| { type: 'message'; channel: Channel | null; message: Omit<Message, 'channel'> }
	| { type: 'sent'; nonce: string }
	| { type: 'send_failed'; nonce: string; error: string };

type Connection = { host: string; port: string; token: string };

const MAX_MESSAGES = 200;

export default function App() {
	const [connection, setConnection] = useState<Connection>({ host: '', port: '47900', token: '' });
	const [editing, setEditing] = useState(true);
	const [status, setStatus] = useState('Not connected');
	const [channels, setChannels] = useState<Record<string, Channel>>({});
	const [messages, setMessages] = useState<Record<string, Message[]>>({});
	const [pending, setPending] = useState<Record<string, string[]>>({});
	const [draft, setDraft] = useState('');
	const [sendError, setSendError] = useState('');
	const [selected, setSelected] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const socket = useRef<WebSocket | null>(null);
	const threadRef = useRef<FlatList<Message> | null>(null);
	const selectedRef = useRef<string | null>(null);
	const editingRef = useRef(true);
	const shouldConnect = useRef(false);
	const reconnectAttempt = useRef(0);
	const reconnectTimer = useRef<number | null>(null);
	const connectRef = useRef<() => void>(() => {});

	const scheduleReconnect = useCallback(() => {
		if (reconnectTimer.current) return;
		if (!shouldConnect.current || editingRef.current || AppState.currentState !== 'active') return;
		const delays = [1000, 2000, 5000, 10000];
		const delay = delays[Math.min(reconnectAttempt.current, delays.length - 1)];
		reconnectAttempt.current = Math.min(reconnectAttempt.current + 1, delays.length - 1);
		setStatus('Reconnecting…');
		reconnectTimer.current = setTimeout(() => {
			reconnectTimer.current = null;
			connectRef.current();
		}, delay);
	}, []);

	const connect = useCallback(() => {
		if (reconnectTimer.current) {
			clearTimeout(reconnectTimer.current);
			reconnectTimer.current = null;
		}
		socket.current?.close();
		const url = `ws://${connection.host.trim()}:${connection.port.trim()}/?token=${connection.token.trim()}`;
		setStatus('Connecting…');
		const next = new WebSocket(url);
		next.onopen = () => {
			shouldConnect.current = true;
			reconnectAttempt.current = 0;
			if (reconnectTimer.current) {
				clearTimeout(reconnectTimer.current);
				reconnectTimer.current = null;
			}
			setStatus('Connected');
			setEditing(false);
			const channel = selectedRef.current;
			if (channel) next.send(JSON.stringify({ type: 'open', channel }));
		};
		next.onerror = () => {
			if (next !== socket.current) return;
			if (shouldConnect.current) {
				scheduleReconnect();
			} else {
				setStatus('Could not reach Serein; check the address, port and token');
			}
		};
		next.onclose = () => {
			if (next !== socket.current) return;
			setStatus((current) => (current === 'Connected' ? 'Disconnected' : current));
			scheduleReconnect();
		};
		next.onmessage = (event) => {
			let frame: Frame;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (frame.type === 'channel') {
				setChannels((current) => ({ ...current, [frame.channel.id]: frame.channel }));
			} else if (frame.type === 'sent') {
				setPending((current) => {
					const next: Record<string, string[]> = {};
					for (const [channel, nonces] of Object.entries(current)) {
						const kept = nonces.filter((nonce) => nonce !== frame.nonce);
						if (kept.length > 0) next[channel] = kept;
					}
					return next;
				});
			} else if (frame.type === 'send_failed') {
				setPending((current) => {
					const next: Record<string, string[]> = {};
					for (const [channel, nonces] of Object.entries(current)) {
						const kept = nonces.filter((nonce) => nonce !== frame.nonce);
						if (kept.length > 0) next[channel] = kept;
					}
					return next;
				});
				setSendError(frame.error);
			} else if (frame.type === 'message') {
				const channel = frame.channel;
				if (!channel) return;
				const message: Message = { ...frame.message, channel: channel.id };
				setChannels((current) => ({ ...current, [channel.id]: channel }));
				setMessages((current) => {
					const existing = current[channel.id] ?? [];
					if (existing.some((entry) => entry.id === message.id)) return current;
					const next = [...existing, message].slice(-MAX_MESSAGES);
					return { ...current, [channel.id]: next };
				});
			}
		};
		socket.current = next;
	}, [connection, scheduleReconnect]);

	useEffect(() => {
		connectRef.current = connect;
	}, [connect]);

	useEffect(() => {
		editingRef.current = editing;
		selectedRef.current = selected;
	}, [editing, selected]);

	useEffect(
		() => () => {
			socket.current?.close();
			if (reconnectTimer.current) {
				clearTimeout(reconnectTimer.current);
				reconnectTimer.current = null;
			}
		},
		[],
	);

	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state !== 'active' || editingRef.current) return;
			if (socket.current?.readyState !== WebSocket.OPEN) connectRef.current();
		});
		return () => subscription.remove();
	}, []);

	useEffect(() => {
		const subscription = Keyboard.addListener('keyboardDidShow', () => {
			threadRef.current?.scrollToEnd({ animated: true });
		});
		return () => subscription.remove();
	}, []);

	const rows = useMemo(() => {
		const grouped = new Map<string, Channel[]>();
		for (const channel of Object.values(channels)) {
			const group = channel.guild ?? 'Direct messages';
			grouped.set(group, [...(grouped.get(group) ?? []), channel]);
		}
		return [...grouped.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([group, list]) => ({
				group,
				channels: list.sort((left, right) => left.name.localeCompare(right.name)),
			}));
	}, [channels]);

	const open = useCallback(
		(channel: string) => {
			setSelected(channel);
			console.log('open', channel, socket.current?.readyState);
			socket.current?.send(JSON.stringify({ type: 'open', channel }));
		},
		[],
	);

	const refresh = useCallback(() => {
		if (selected) socket.current?.send(JSON.stringify({ type: 'open', channel: selected }));
		setRefreshing(true);
		setTimeout(() => setRefreshing(false), 800);
	}, [selected]);

	const send = useCallback(() => {
		const content = draft.trim();
		if (!content || !selected || socket.current?.readyState !== WebSocket.OPEN) return;
		const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
		socket.current.send(JSON.stringify({ type: 'send', channel: selected, nonce, content }));
		setPending((current) => ({ ...current, [selected]: [...(current[selected] ?? []), nonce] }));
		setDraft('');
		setSendError('');
	}, [draft, selected]);

	const active = selected ? channels[selected] : undefined;
	const thread = selected ? (messages[selected] ?? []) : [];

	if (editing) {
		return (
			<SafeAreaView style={styles.screen}>
				<StatusBar style="light" />
				<ScrollView contentContainerStyle={styles.form}>
					<Text style={styles.title}>Serein Voice</Text>
					<Text style={styles.hint}>
						On the computer, open Settings → Voice &amp; Video, enable Phone bridge, and copy the
						port and token it shows.
					</Text>
					<Text style={styles.label}>Computer address</Text>
					<TextInput
						style={styles.input}
						value={connection.host}
						onChangeText={(host) => setConnection((current) => ({ ...current, host }))}
						placeholder="192.168.1.20"
						placeholderTextColor="#6b7280"
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="numbers-and-punctuation"
					/>
					<Text style={styles.label}>Port</Text>
					<TextInput
						style={styles.input}
						value={connection.port}
						onChangeText={(port) => setConnection((current) => ({ ...current, port }))}
						placeholder="47900"
						placeholderTextColor="#6b7280"
						keyboardType="number-pad"
					/>
					<Text style={styles.label}>Token</Text>
					<TextInput
						style={styles.input}
						value={connection.token}
						onChangeText={(token) => setConnection((current) => ({ ...current, token }))}
						placeholder="32 hexadecimal characters"
						placeholderTextColor="#6b7280"
						autoCapitalize="none"
						autoCorrect={false}
					/>
					<Pressable style={styles.button} onPress={connect}>
						<Text style={styles.buttonText}>Connect</Text>
					</Pressable>
					<Text style={styles.hint}>{status}</Text>
				</ScrollView>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView style={styles.screen}>
			<StatusBar style="light" />
			<View style={styles.header}>
				<Text style={styles.title}>Serein Voice</Text>
				<Pressable
					onPress={() => {
						shouldConnect.current = false;
						if (reconnectTimer.current) {
							clearTimeout(reconnectTimer.current);
							reconnectTimer.current = null;
						}
						setEditing(true);
					}}
				>
					<Text style={styles.link}>{status === 'Connected' ? 'Connection' : status}</Text>
				</Pressable>
			</View>
			{status === 'Connecting…' ? <ActivityIndicator color="#8ab4f8" /> : null}
			{active ? (
				<KeyboardAvoidingView style={styles.thread} behavior="padding" keyboardVerticalOffset={0}>
					<Pressable onPress={() => setSelected(null)} style={styles.back}>
						<Text style={styles.link}>‹ {active.guild ?? 'Direct messages'} / {active.name}</Text>
					</Pressable>
					<FlatList
						ref={threadRef}
						data={thread}
						keyExtractor={(message) => message.id}
						contentContainerStyle={styles.messages}
						keyboardShouldPersistTaps="handled"
						onContentSizeChange={() => threadRef.current?.scrollToEnd({ animated: true })}
						refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
						ListEmptyComponent={<Text style={styles.hint}>No messages yet.</Text>}
						renderItem={({ item }) => (
							<View style={styles.message}>
								<Text style={styles.author}>{item.author}</Text>
								<Text style={styles.content}>{item.content || '(attachment)'}</Text>
							</View>
						)}
					/>
					{sendError ? <Text style={styles.error}>{sendError}</Text> : null}
					<View style={styles.composer}>
						<TextInput
							style={styles.composerInput}
							value={draft}
							onChangeText={setDraft}
							placeholder={`Message ${active.name}`}
							placeholderTextColor="#6b7280"
							multiline
							onSubmitEditing={send}
						/>
						<Pressable style={styles.sendButton} onPress={send}>
							<Text style={styles.buttonText}>Send</Text>
						</Pressable>
					</View>
					{pending[selected ?? '']?.length ? (
						<Text style={styles.hint}>Sending…</Text>
					) : null}
				</KeyboardAvoidingView>
			) : (
				<FlatList
					data={rows}
					keyExtractor={(row) => row.group}
					contentContainerStyle={styles.messages}
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
					ListEmptyComponent={
						<Text style={styles.hint}>
							Waiting for channels. Serein sends them after it connects to Discord.
						</Text>
					}
					renderItem={({ item }) => (
						<View>
							<Text style={styles.group}>{item.group}</Text>
							{item.channels.map((channel) => {
								const unread = messages[channel.id] ?? [];
								const last = unread[unread.length - 1];
								return (
									<Pressable
										key={channel.id}
										style={styles.row}
										onPress={() => open(channel.id)}
									>
										<Text style={styles.rowTitle}>
											{channel.voice ? '🔊 ' : '# '}
											{channel.name}
										</Text>
										<Text style={styles.rowDetail} numberOfLines={1}>
											{last ? `${last.author}: ${last.content}` : 'No messages yet'}
										</Text>
									</Pressable>
								);
							})}
						</View>
					)}
				/>
			)}
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#14161a' },
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: '#2a2e35',
	},
	title: { color: '#f2f3f5', fontSize: 20, fontWeight: '700' },
	link: { color: '#8ab4f8', fontSize: 14 },
	hint: { color: '#9aa0a6', fontSize: 13, lineHeight: 18, marginVertical: 8 },
	form: { padding: 20, gap: 4 },
	label: { color: '#c7ccd1', fontSize: 13, marginTop: 12 },
	input: {
		backgroundColor: '#1e2126',
		borderRadius: 8,
		color: '#f2f3f5',
		fontSize: 16,
		marginTop: 4,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	button: {
		backgroundColor: '#5865f2',
		borderRadius: 8,
		marginTop: 20,
		paddingVertical: 12,
		alignItems: 'center',
	},
	buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
	group: {
		color: '#9aa0a6',
		fontSize: 12,
		fontWeight: '700',
		letterSpacing: 0.6,
		marginTop: 18,
		marginBottom: 6,
		textTransform: 'uppercase',
	},
	row: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#23272e' },
	rowTitle: { color: '#f2f3f5', fontSize: 16 },
	rowDetail: { color: '#9aa0a6', fontSize: 13, marginTop: 2 },
	messages: { padding: 16 },
	thread: { flex: 1 },
	back: { paddingHorizontal: 16, paddingVertical: 10 },
	message: { marginBottom: 12 },
	composer: {
		alignItems: 'flex-end',
		borderTopColor: '#2a2e35',
		borderTopWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		gap: 8,
		padding: 12,
	},
	composerInput: {
		backgroundColor: '#1e2126',
		borderRadius: 18,
		color: '#f2f3f5',
		flex: 1,
		fontSize: 15,
		maxHeight: 120,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	sendButton: {
		backgroundColor: '#5865f2',
		borderRadius: 18,
		paddingHorizontal: 16,
		paddingVertical: 10,
	},
	error: { color: '#f28b82', fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
	author: { color: '#8ab4f8', fontSize: 13, fontWeight: '600' },
	content: { color: '#e3e5e8', fontSize: 15, marginTop: 2 },
});
