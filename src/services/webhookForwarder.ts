import axios from 'axios'
import { Api } from 'telegram/tl'
import { TelegramClient } from 'telegram'
import type { TelegramMessage } from './telegramListener'
import type { ChannelMapping } from '../config'
import FormData from 'form-data'

export class WebhookForwarder {
  private channelMappings: ChannelMapping[]
  private telegramClient: (() => TelegramClient | null)

  constructor(channelMappings: ChannelMapping[], getTelegramClient: () => TelegramClient | null) {
    this.channelMappings = channelMappings
    this.telegramClient = getTelegramClient

    console.log('[Forwarder] 채널 매핑:')
    this.channelMappings.forEach((m) => {
      // webhook URL에서 ID 부분만 표시 (보안)
      const webhookIdMatch = m.webhookUrl.match(/\/webhooks\/(\d+)\//)
      const safeUrl = webhookIdMatch ? `...webhooks/${webhookIdMatch[1]}/***` : '***'
      console.log(`  - ${m.telegramChannel} -> ${safeUrl}`)
    })
  }

  findWebhookUrl(message: TelegramMessage): string | null {
    for (const mapping of this.channelMappings) {
      if (this.matchesChannel(message, mapping.telegramChannel)) {
        return mapping.webhookUrl
      }
    }
    return null
  }

  private matchesChannel(message: TelegramMessage, target: string): boolean {
    const normalizedTarget = target.replace(/^@/, '').toLowerCase()

    if (message.chatUsername) {
      const normalized = message.chatUsername.replace(/^@/, '').toLowerCase()
      if (normalized === normalizedTarget || message.chatUsername === target) return true
    }

    if (message.chatTitle) {
      if (message.chatTitle.toLowerCase() === normalizedTarget || message.chatTitle === target) return true
    }

    if (message.chatId && message.chatId === target) return true

    return false
  }

  async forward(message: TelegramMessage): Promise<void> {
    const webhookUrl = this.findWebhookUrl(message)
    if (!webhookUrl) {
      console.log(`[Forwarder] 매핑되지 않은 채널: ${message.chatUsername || message.chatTitle || message.chatId}`)
      return
    }

    const sourceName = message.chatTitle || message.chatUsername || message.chatId || 'Unknown'
    console.log(`[Forwarder] 매핑 발견: ${sourceName} -> webhook`)

    try {
      await this.sendToWebhook(webhookUrl, message, sourceName)
    } catch (error) {
      console.error('[Forwarder] 전송 실패:', error)
    }
  }

  private async sendToWebhook(webhookUrl: string, message: TelegramMessage, sourceName: string): Promise<void> {
    const embed: Record<string, unknown> = {
      title: `📨 ${sourceName}`,
      color: 0x0099ff,
      timestamp: new Date(message.date * 1000).toISOString(),
      footer: { text: 'Telegram에서 전달됨' },
    }

    if (message.text) {
      const truncated = message.text.length > 4000 ? message.text.substring(0, 3997) + '...' : message.text
      embed.description = truncated
    }

    // 미디어 처리
    const files = await this.downloadMedia(message)

    if (files.length > 0) {
      // 미디어가 있으면 multipart/form-data로 전송
      const formData = new FormData()

      const payload: Record<string, unknown> = { embeds: [embed] }
      formData.append('payload_json', JSON.stringify(payload))

      for (let i = 0; i < files.length; i++) {
        formData.append(`files[${i}]`, files[i].buffer, {
          filename: files[i].name,
          contentType: files[i].contentType,
        })
      }

      await axios.post(webhookUrl, formData, {
        headers: formData.getHeaders(),
        maxBodyLength: 25 * 1024 * 1024,
      })
    } else {
      // 텍스트만 있으면 JSON으로 전송
      await axios.post(webhookUrl, { embeds: [embed] }, {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`[Forwarder] 전송 완료: ${sourceName} (미디어: ${files.length}개)`)
  }

  private async downloadMedia(message: TelegramMessage): Promise<{ buffer: Buffer; name: string; contentType: string }[]> {
    if (!message.media) return []

    const client = this.telegramClient()
    if (!client) return []

    const files: { buffer: Buffer; name: string; contentType: string }[] = []
    const media = message.media

    try {
      // 사진
      if (media instanceof Api.MessageMediaPhoto && media.photo) {
        console.log('[Forwarder] 사진 다운로드 중...')
        const buffer = await client.downloadMedia(message.rawMessage, {})
        if (buffer && Buffer.isBuffer(buffer)) {
          files.push({ buffer, name: `photo_${message.id}.jpg`, contentType: 'image/jpeg' })
          console.log('[Forwarder] 사진 다운로드 완료')
        }
      }
      // 문서 (비디오, GIF, 파일 등)
      else if (media instanceof Api.MessageMediaDocument && media.document) {
        const doc = media.document as Api.Document
        const fileSize = 'size' in doc ? Number(doc.size) : 0
        const maxSize = 8 * 1024 * 1024 // 8MB

        if (fileSize > maxSize) {
          console.log(`[Forwarder] 파일 크기 초과 (${(fileSize / 1024 / 1024).toFixed(2)}MB), 건너뜀`)
          return files
        }

        console.log('[Forwarder] 문서/비디오 다운로드 중...')
        const buffer = await client.downloadMedia(message.rawMessage, {})
        if (buffer && Buffer.isBuffer(buffer)) {
          let fileName = `file_${message.id}`
          let contentType = 'application/octet-stream'

          if ('attributes' in doc && Array.isArray(doc.attributes)) {
            for (const attr of doc.attributes) {
              if (attr instanceof Api.DocumentAttributeFilename) {
                fileName = attr.fileName
                break
              }
            }
          }

          if ('mimeType' in doc && doc.mimeType) {
            contentType = doc.mimeType as string
            if (!fileName.includes('.')) {
              if (contentType.startsWith('video/')) fileName += '.mp4'
              else if (contentType === 'image/gif') fileName += '.gif'
              else if (contentType.startsWith('image/')) fileName += '.jpg'
            }
          }

          files.push({ buffer, name: fileName, contentType })
          console.log(`[Forwarder] 파일 다운로드 완료: ${fileName}`)
        }
      }
    } catch (error) {
      console.error('[Forwarder] 미디어 다운로드 실패:', error)
    }

    return files
  }
}
