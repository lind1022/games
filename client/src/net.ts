import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '@game/shared';

type WorldStateMsg = Extract<ServerMessage, { type: 'world-state' }>;
type BlockUpdateMsg = Extract<ServerMessage, { type: 'block-update' }>;
type PlayerJoinMsg = Extract<ServerMessage, { type: 'player-join' }>;
type PlayerLeaveMsg = Extract<ServerMessage, { type: 'player-leave' }>;
type PlayerStateMsg = Extract<ServerMessage, { type: 'player-state' }>;
type ChatMessageMsg = Extract<ServerMessage, { type: 'chat-message' }>;
type ErrorMsg = Extract<ServerMessage, { type: 'error' }>;

export interface NetHandlers {
  onOpen: () => void;
  onClose: () => void;
  onWorldState: (msg: WorldStateMsg) => void;
  onBlockUpdate: (msg: BlockUpdateMsg) => void;
  onPlayerJoin: (msg: PlayerJoinMsg) => void;
  onPlayerLeave: (msg: PlayerLeaveMsg) => void;
  onPlayerState: (msg: PlayerStateMsg) => void;
  onChatMessage: (msg: ChatMessageMsg) => void;
  onError: (msg: ErrorMsg) => void;
}

/** WebSocket client wrapper: handshake, schema-validated in/out, dispatch to handlers. */
export class Net {
  private readonly socket: WebSocket;

  constructor(displayName: string, private readonly handlers: NetHandlers) {
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${wsProtocol}://${location.host}/ws`);

    this.socket.addEventListener('open', () => {
      this.handlers.onOpen();
      // Dev-stub join (Phases 1-3): `code` is present but unvalidated by the
      // server until Phase 4 — see shared/protocol.ts contract #9.
      this.send({ type: 'join', protocolVersion: PROTOCOL_VERSION, code: 'dev', name: displayName });
    });
    this.socket.addEventListener('close', () => this.handlers.onClose());
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
  }

  send(message: ClientMessage): void {
    const parsed = clientMessageSchema.parse(message);
    this.socket.send(JSON.stringify(parsed));
  }

  private handleMessage(event: MessageEvent): void {
    let raw: unknown;
    try {
      raw = JSON.parse(event.data as string);
    } catch {
      console.error('[net] received non-JSON message');
      return;
    }

    const result = serverMessageSchema.safeParse(raw);
    if (!result.success) {
      console.error('[net] received malformed message', result.error);
      return;
    }

    const msg = result.data;
    switch (msg.type) {
      case 'world-state':
        this.handlers.onWorldState(msg);
        break;
      case 'block-update':
        this.handlers.onBlockUpdate(msg);
        break;
      case 'player-join':
        this.handlers.onPlayerJoin(msg);
        break;
      case 'player-leave':
        this.handlers.onPlayerLeave(msg);
        break;
      case 'player-state':
        this.handlers.onPlayerState(msg);
        break;
      case 'chat-message':
        this.handlers.onChatMessage(msg);
        break;
      case 'error':
        this.handlers.onError(msg);
        break;
    }
  }
}
