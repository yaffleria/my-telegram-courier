import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { Api } from 'telegram/tl'
import * as readline from 'readline'

export interface TelegramMessage {
  id: number
  text: string
  chatUsername?: string
  chatTitle?: string
  chatId?: string
  date: number
  media?: Api.TypeMessageMedia
  rawMessage: Api.Message
}

type MessageHandler = (message: TelegramMessage) => Promise<void>

export class TelegramListener {
  private client: TelegramClient | null = null
  private apiId: number
  private apiHash: string
  private phoneNumber?: string
  private sessionString: string
  private messageHandler: MessageHandler | null = null

  constructor(apiId: number, apiHash: string, phoneNumber?: string, sessionString = '') {
    this.apiId = apiId
    this.apiHash = apiHash
    this.phoneNumber = phoneNumber
    this.sessionString = sessionString
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  private async getUserInput(prompt: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close()
        resolve(answer)
      })
    })
  }

  async start(): Promise<void> {
    // StringSession은 빈 문자열('') 또는 유효한 세션 문자열만 허용
    const sessionStr = this.sessionString.trim() || ''
    console.log(`[Telegram] 세션 상태: ${sessionStr ? `${sessionStr.length}자 로드됨` : '새 세션 생성'}`)

    this.client = new TelegramClient(
      new StringSession(sessionStr),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5 }
    )

    console.log('[Telegram] 클라이언트 연결 시도 중...')

    await this.client.start({
      phoneNumber: async () => {
        if (this.phoneNumber) return this.phoneNumber
        return await this.getUserInput('[Telegram] 전화번호를 입력하세요 (형식: +821012345678): ')
      },
      password: async () => {
        console.log('[Telegram] 2FA 비밀번호가 필요합니다.')
        return await this.getUserInput('[Telegram] 2FA 비밀번호를 입력하세요: ')
      },
      phoneCode: async () => {
        console.log('[Telegram] 텔레그램 앱에서 받은 인증 코드가 필요합니다.')
        return await this.getUserInput('[Telegram] 인증 코드를 입력하세요: ')
      },
      onError: (error: Error) => console.error('[Telegram] 에러:', error),
    })

    console.log('[Telegram] 클라이언트 연결 완료')

    // 세션 문자열 출력 (서버 환경 배포용)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const session = this.client.session.save() as unknown as string
    if (session && session.length > 0) {
      console.log('[Telegram] ============================================')
      console.log('[Telegram] 세션 문자열 (TELEGRAM_SESSION 환경변수에 설정하세요):')
      console.log(session)
      console.log('[Telegram] ============================================')
    }

    this.registerEventHandlers()
  }

  private registerEventHandlers(): void {
    if (!this.client) throw new Error('Telegram client is not initialized')

    this.client.addEventHandler(async (event: NewMessageEvent) => {
      await this.handleNewMessage(event)
    }, new NewMessage({}))

    console.log('[Telegram] 이벤트 핸들러 등록 완료')
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    if (!this.client || !this.messageHandler) return

    try {
      const message = event.message

      let chatUsername: string | undefined
      let chatTitle: string | undefined
      let chatId: string | undefined

      // 방법 1: event.getChat()
      try {
        const chat = await event.getChat()
        if (chat) {
          chatUsername = 'username' in chat ? (chat.username as string | undefined) : undefined
          chatTitle = 'title' in chat ? (chat.title as string | undefined) : undefined
          chatId = 'id' in chat ? String(chat.id) : undefined
        }
      } catch {
        // fallback
      }

      // 방법 2: message.peerId
      if (!chatUsername && !chatTitle && !chatId && message.peerId) {
        try {
          const peerId = message.peerId
          chatId = String(
            'channelId' in peerId
              ? peerId.channelId
              : 'userId' in peerId
                ? peerId.userId
                : peerId
          )

          try {
            const entity = await this.client.getEntity(peerId)
            if (entity) {
              chatUsername = 'username' in entity ? (entity.username as string | undefined) : undefined
              chatTitle = 'title' in entity ? (entity.title as string | undefined) : undefined
            }
          } catch {
            // fallback
          }
        } catch {
          // fallback
        }
      }

      if (!chatUsername && !chatTitle && !chatId) {
        console.log('[Telegram] 채널 정보를 가져올 수 없어 건너뜁니다.')
        return
      }

      console.log(`[Telegram] 메시지 수신: channel=${chatUsername || chatTitle || chatId}, text=${(message.message || '').substring(0, 50)}...`)

      await this.messageHandler({
        id: message.id,
        text: message.message || '',
        chatUsername,
        chatTitle,
        chatId,
        date: message.date ?? Math.floor(Date.now() / 1000),
        media: message.media,
        rawMessage: message,
      })
    } catch (error) {
      console.error('[Telegram] 메시지 처리 중 에러:', error)
    }
  }

  getClient(): TelegramClient | null {
    return this.client
  }

  async stop(): Promise<void> {
    if (this.client) {
      console.log('[Telegram] 클라이언트 연결 종료 중...')
      await this.client.disconnect()
      this.client = null
      console.log('[Telegram] 연결 종료 완료')
    }
  }
}
