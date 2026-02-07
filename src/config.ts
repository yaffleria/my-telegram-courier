import 'dotenv/config'

export interface ChannelMapping {
  telegramChannel: string
  webhookUrl: string
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`환경변수 ${key}가 설정되지 않았습니다.`)
  }
  return value
}

function parseChannelMappings(raw: string): ChannelMapping[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('CHANNEL_MAPPINGS는 JSON 배열이어야 합니다.')
    }
    for (const item of parsed) {
      if (!item.telegramChannel || !item.webhookUrl) {
        throw new Error('각 매핑에는 telegramChannel과 webhookUrl이 필요합니다.')
      }
    }
    return parsed
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`CHANNEL_MAPPINGS JSON 파싱 실패: ${error.message}`)
    }
    throw error
  }
}

export const config = {
  telegram: {
    apiId: Number(requireEnv('TELEGRAM_API_ID')),
    apiHash: requireEnv('TELEGRAM_API_HASH'),
    phoneNumber: process.env.TELEGRAM_PHONE_NUMBER,
    session: process.env.TELEGRAM_SESSION || '',
  },
  channelMappings: parseChannelMappings(process.env.CHANNEL_MAPPINGS || '[]'),
}
