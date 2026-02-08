import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram/tl";
import * as readline from "readline";

export interface TelegramMessage {
  id: number;
  text: string;
  chatUsername?: string;
  chatTitle?: string;
  chatId?: string;
  date: number;
  media?: Api.TypeMessageMedia;
  rawMessage: Api.Message;
}

type MessageHandler = (message: TelegramMessage) => Promise<void>;

export class TelegramListener {
  private client: TelegramClient | null = null;
  private apiId: number;
  private apiHash: string;
  private phoneNumber?: string;
  private sessionString: string;
  private messageHandler: MessageHandler | null = null;
  // 메시지 중복 처리 방지용 (chatId + messageId 조합)
  private processedMessages: Set<string> = new Set();
  // 최대 캐시 크기 (메모리 관리)
  private readonly MAX_CACHE_SIZE = 1000;

  // 폴링 관련
  private channelsToPoll: string[] = [];
  private currentPollIndex = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  constructor(
    apiId: number,
    apiHash: string,
    phoneNumber?: string,
    sessionString = "",
  ) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.phoneNumber = phoneNumber;
    this.sessionString = sessionString;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  private async getUserInput(prompt: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  async start(): Promise<void> {
    // StringSession은 빈 문자열('') 또는 유효한 세션 문자열만 허용
    const sessionStr = this.sessionString.trim() || "";
    console.log(
      `[Telegram] 세션 상태: ${sessionStr ? `${sessionStr.length}자 로드됨` : "새 세션 생성"}`,
    );

    this.client = new TelegramClient(
      new StringSession(sessionStr),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5 },
    );

    console.log("[Telegram] 클라이언트 연결 시도 중...");

    await this.client.start({
      phoneNumber: async () => {
        if (this.phoneNumber) return this.phoneNumber;
        return await this.getUserInput(
          "[Telegram] 전화번호를 입력하세요 (형식: +821012345678): ",
        );
      },
      password: async () => {
        console.log("[Telegram] 2FA 비밀번호가 필요합니다.");
        return await this.getUserInput(
          "[Telegram] 2FA 비밀번호를 입력하세요: ",
        );
      },
      phoneCode: async () => {
        console.log("[Telegram] 텔레그램 앱에서 받은 인증 코드가 필요합니다.");
        return await this.getUserInput("[Telegram] 인증 코드를 입력하세요: ");
      },
      onError: (error: Error) => console.error("[Telegram] 에러:", error),
    });

    console.log("[Telegram] 클라이언트 연결 완료");

    // 세션 문자열 출력 (서버 환경 배포용)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const session = this.client.session.save() as unknown as string;
    if (session && session.length > 0) {
      console.log("[Telegram] ============================================");
      console.log(
        "[Telegram] 세션 문자열 (TELEGRAM_SESSION 환경변수에 설정하세요):",
      );
      console.log(session);
      console.log("[Telegram] ============================================");
    }

    // 모든 대화 목록을 가져와 엔티티 캐시 초기화
    // (Telegram API는 "본 적 없는" 채널의 메시지를 처리할 수 없음)
    console.log("[Telegram] 채널 목록 캐싱 중...");
    const dialogs = await this.client.getDialogs({ limit: 500 });
    console.log(`[Telegram] ${dialogs.length}개 대화 캐시됨`);

    // 디버깅: 캐시된 채널 목록 출력
    dialogs.forEach((dialog) => {
      const entity = dialog.entity;
      if (!entity) return;
      const username = "username" in entity ? entity.username : undefined;
      const title = "title" in entity ? entity.title : undefined;
      const id = "id" in entity ? entity.id : undefined;
      if (username || title) {
        console.log(`  - [${id}] ${title || "N/A"} (@${username || "N/A"})`);
      }
    });

    this.registerEventHandlers();

    // 폴링 시작
    this.startPolling();
  }

  setChannelsToPoll(channels: string[]) {
    this.channelsToPoll = channels;
    console.log(`[Telegram] 폴링 대상 채널 설정됨: ${channels.length}개`);
  }

  private startPolling() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);

    if (this.channelsToPoll.length === 0) {
      console.log("[Telegram] 폴링 대상 채널이 없습니다.");
      return;
    }

    console.log(
      `[Telegram] 폴링 시작 (대상: ${this.channelsToPoll.length}개 채널, 2초 간격 순차 확인)`,
    );

    // 2초마다 채널 하나씩 순차 확인 (API 제한 고려)
    this.pollingInterval = setInterval(async () => {
      if (this.channelsToPoll.length === 0 || !this.client) return;

      const channelName = this.channelsToPoll[this.currentPollIndex];
      this.currentPollIndex =
        (this.currentPollIndex + 1) % this.channelsToPoll.length;

      try {
        // 최근 메시지 1개만 가져옴
        const messages = await this.client.getMessages(channelName, {
          limit: 1,
        });
        if (messages && messages.length > 0) {
          const message = messages[0];
          if (message instanceof Api.Message) {
            // 중복 체크 및 처리는 handleRawChannelMessage에서 수행
            // (이미 처리된 메시지는 무시됨)
            await this.handleRawChannelMessage(message, true);
          }
        }
      } catch (e) {
        // 폴링 에러는 너무 시끄럽지 않게 에러 메시지만
        // console.error(`[Telegram] Polling error for ${channelName}:`, e);
      }
    }, 2000);
  }

  private registerEventHandlers(): void {
    if (!this.client) throw new Error("Telegram client is not initialized");

    // 방법 1: NewMessage 핸들러 (일부 채널에서 작동)
    this.client.addEventHandler((event: NewMessageEvent) => {
      this.handleNewMessage(event).catch((err) => {
        console.error("[Telegram] NewMessage 핸들러 에러:", err);
      });
    }, new NewMessage({}));

    // 방법 2: Raw 핸들러로 모든 채널 메시지 수신 (UpdateNewChannelMessage)
    this.client.addEventHandler(async (update: Api.TypeUpdate) => {
      try {
        // 채널의 새 메시지 업데이트
        if (update instanceof Api.UpdateNewChannelMessage) {
          console.log("[Telegram] 📡 Raw UpdateNewChannelMessage 수신");
          const message = update.message;
          if (message instanceof Api.Message) {
            await this.handleRawChannelMessage(message);
          }
        }
        // 일반 새 메시지 업데이트 (그룹/DM)
        else if (update instanceof Api.UpdateNewMessage) {
          console.log("[Telegram] 📡 Raw UpdateNewMessage 수신");
          const message = update.message;
          if (message instanceof Api.Message) {
            await this.handleRawChannelMessage(message);
          }
        }
      } catch (err) {
        console.error("[Telegram] Raw 핸들러 에러:", err);
      }
    });

    console.log("[Telegram] 이벤트 핸들러 등록 완료 (NewMessage + Raw)");
  }

  private async handleRawChannelMessage(
    message: Api.Message,
    isPolling = false,
  ): Promise<void> {
    if (!this.client || !this.messageHandler) return;

    const peerId = message.peerId;
    if (!peerId) return;

    // 중복 체크용 키
    const chatIdForDedup =
      "channelId" in peerId
        ? String(peerId.channelId)
        : "chatId" in peerId
          ? String(peerId.chatId)
          : "userId" in peerId
            ? String(peerId.userId)
            : "unknown";
    const messageKey = `${chatIdForDedup}:${message.id}`;

    // 이미 처리된 메시지 건너뛰기
    if (this.processedMessages.has(messageKey)) {
      return; // Raw 핸들러는 중복 로그 생략
    }
    this.processedMessages.add(messageKey);

    // 캐시 크기 관리
    if (this.processedMessages.size > this.MAX_CACHE_SIZE) {
      const iterator = this.processedMessages.values();
      for (let i = 0; i < this.MAX_CACHE_SIZE / 2; i++) {
        const oldKey = iterator.next().value;
        if (oldKey) this.processedMessages.delete(oldKey);
      }
    }

    if (!isPolling) {
      console.log(
        `[Telegram] 📡 Raw 메시지: key=${messageKey}, text="${(message.message || "").substring(0, 30)}..."`,
      );
    } else {
      console.log(
        `[Telegram] 🔄 Polling 메시지 감지: key=${messageKey}, text="${(message.message || "").substring(0, 30)}..."`,
      );
    }

    // 채널 정보 추출
    let chatUsername: string | undefined;
    let chatTitle: string | undefined;
    let chatId: string | undefined = chatIdForDedup;

    try {
      const entity = await this.client.getEntity(peerId);
      if (entity) {
        chatUsername =
          "username" in entity
            ? (entity.username as string | undefined)
            : undefined;
        chatTitle =
          "title" in entity ? (entity.title as string | undefined) : undefined;
      }
    } catch (e) {
      console.log("[Telegram] Raw getEntity() 실패, ID만 사용:", e);
    }

    console.log(
      `[Telegram] 📡 Raw 채널 정보: username=${chatUsername}, title=${chatTitle}, id=${chatId}`,
    );

    await this.messageHandler({
      id: message.id,
      text: message.message || "",
      chatUsername,
      chatTitle,
      chatId,
      date: message.date ?? Math.floor(Date.now() / 1000),
      media: message.media,
      rawMessage: message,
    });
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    if (!this.client || !this.messageHandler) return;

    try {
      const message = event.message;

      // 디버깅: 모든 이벤트 즉시 로그
      console.log(
        `[Telegram] 📩 RAW 이벤트: peerId=${JSON.stringify(message.peerId)}, msgId=${message.id}, text="${(message.message || "").substring(0, 30)}..."`,
      );

      // 메시지 고유 키 생성 (chatId + messageId)
      const peerId = message.peerId;
      const chatIdForDedup =
        "channelId" in peerId
          ? String(peerId.channelId)
          : "chatId" in peerId
            ? String(peerId.chatId)
            : "userId" in peerId
              ? String(peerId.userId)
              : "unknown";
      const messageKey = `${chatIdForDedup}:${message.id}`;

      // 이미 처리된 메시지인지 확인
      if (this.processedMessages.has(messageKey)) {
        console.log(`[Telegram] 중복 메시지 무시: ${messageKey}`);
        return;
      }

      // 메시지 처리 완료 표시
      this.processedMessages.add(messageKey);

      // 캐시 크기 관리 (오래된 항목 제거)
      if (this.processedMessages.size > this.MAX_CACHE_SIZE) {
        const iterator = this.processedMessages.values();
        // 첫 번째 절반 삭제
        for (let i = 0; i < this.MAX_CACHE_SIZE / 2; i++) {
          const oldKey = iterator.next().value;
          if (oldKey) this.processedMessages.delete(oldKey);
        }
      }

      // peerId 원본 로그 (디버깅용)
      console.log(
        `[Telegram] 이벤트 수신: key=${messageKey}, text=${(message.message || "").substring(0, 30)}...`,
      );

      let chatUsername: string | undefined;
      let chatTitle: string | undefined;
      let chatId: string | undefined;

      // 방법 1: event.getChat()
      try {
        const chat = await event.getChat();
        if (chat) {
          chatUsername =
            "username" in chat
              ? (chat.username as string | undefined)
              : undefined;
          chatTitle =
            "title" in chat ? (chat.title as string | undefined) : undefined;
          chatId = "id" in chat ? String(chat.id) : undefined;
        }
      } catch (e) {
        console.log("[Telegram] event.getChat() 실패:", e);
      }

      // 방법 2: message.peerId
      if (!chatUsername && !chatTitle && !chatId && message.peerId) {
        try {
          const peerId = message.peerId;
          chatId = String(
            "channelId" in peerId
              ? peerId.channelId
              : "userId" in peerId
                ? peerId.userId
                : peerId,
          );

          try {
            const entity = await this.client.getEntity(peerId);
            if (entity) {
              chatUsername =
                "username" in entity
                  ? (entity.username as string | undefined)
                  : undefined;
              chatTitle =
                "title" in entity
                  ? (entity.title as string | undefined)
                  : undefined;
            }
          } catch (e) {
            console.log("[Telegram] getEntity() 실패:", e);
          }
        } catch (e) {
          console.log("[Telegram] peerId 처리 실패:", e);
        }
      }

      console.log(
        `[Telegram] 채널 정보: username=${chatUsername}, title=${chatTitle}, id=${chatId}`,
      );

      if (!chatUsername && !chatTitle && !chatId) {
        console.log("[Telegram] 채널 정보를 가져올 수 없어 건너뜁니다.");
        return;
      }

      await this.messageHandler({
        id: message.id,
        text: message.message || "",
        chatUsername,
        chatTitle,
        chatId,
        date: message.date ?? Math.floor(Date.now() / 1000),
        media: message.media,
        rawMessage: message,
      });
    } catch (error) {
      console.error("[Telegram] 메시지 처리 중 에러:", error);
    }
  }

  getClient(): TelegramClient | null {
    return this.client;
  }

  async stop(): Promise<void> {
    if (this.client) {
      console.log("[Telegram] 클라이언트 연결 종료 중...");
      await this.client.disconnect();
      this.client = null;
      console.log("[Telegram] 연결 종료 완료");
    }
  }
}
