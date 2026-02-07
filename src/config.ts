import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

// .env 파일을 직접 읽어서 멀티라인 값을 지원
function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return

  const content = fs.readFileSync(envPath, 'utf-8')
  const result: Record<string, string> = {}
  let currentKey: string | null = null
  let currentValue = ''
  let inMultiline = false

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    // 멀티라인 값 수집 중
    if (inMultiline) {
      currentValue += line
      // JSON 배열이 닫히는지 확인
      try {
        JSON.parse(currentValue)
        // 파싱 성공 = 완전한 JSON
        result[currentKey!] = currentValue
        inMultiline = false
        currentKey = null
        currentValue = ''
      } catch {
        // 아직 불완전한 JSON, 계속 수집
      }
      continue
    }

    // 빈 줄이나 주석 무시
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    const key = match[1]
    let value = match[2]

    // 따옴표 제거
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // [ 로 시작하지만 JSON 파싱이 안 되면 멀티라인
    if (value.startsWith('[')) {
      try {
        JSON.parse(value)
        result[key] = value
      } catch {
        currentKey = key
        currentValue = value
        inMultiline = true
      }
      continue
    }

    result[key] = value
  }

  // 이미 설정된 환경변수는 덮어쓰지 않음 (Railway 등 서버 환경변수 우선)
  for (const [key, value] of Object.entries(result)) {
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

// dotenv 기본 로드 (한 줄 값 처리) + 멀티라인 커스텀 로드
dotenv.config()
loadEnv()

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
