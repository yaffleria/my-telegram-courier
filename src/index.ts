import http from 'http'
import { config } from './config'
import { TelegramListener } from './services/telegramListener'
import { WebhookForwarder } from './services/webhookForwarder'

async function main() {
  console.log('=== Telegram Courier 시작 ===')

  // Railway health check용 HTTP 서버
  const port = process.env.PORT || 3000
  http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  }).listen(port, () => {
    console.log(`[Health] HTTP 서버 시작 (port: ${port})`)
  })

  if (config.channelMappings.length === 0) {
    console.warn('[경고] CHANNEL_MAPPINGS가 비어있습니다. 매핑을 설정해주세요.')
  }

  const listener = new TelegramListener(
    config.telegram.apiId,
    config.telegram.apiHash,
    config.telegram.phoneNumber,
    config.telegram.session
  )

  const forwarder = new WebhookForwarder(
    config.channelMappings,
    () => listener.getClient()
  )

  listener.onMessage(async (message) => {
    await forwarder.forward(message)
  })

  await listener.start()

  console.log('=== Telegram Courier 실행 중 ===')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n종료 신호 수신...')
    await listener.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('치명적 에러:', error)
  process.exit(1)
})
