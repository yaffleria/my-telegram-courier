import { config } from "./config";
import { TelegramListener } from "./services/telegramListener";
import { WebhookForwarder } from "./services/webhookForwarder";

async function main() {
  console.log("=== Telegram Courier 시작 ===");

  if (config.channelMappings.length === 0) {
    console.warn(
      "[경고] CHANNEL_MAPPINGS가 비어있습니다. 매핑을 설정해주세요.",
    );
  }

  const listener = new TelegramListener(
    config.telegram.apiId,
    config.telegram.apiHash,
    config.telegram.phoneNumber,
    config.telegram.session,
  );

  const forwarder = new WebhookForwarder(config.channelMappings, () =>
    listener.getClient(),
  );

  listener.onMessage(async (message) => {
    await forwarder.forward(message);
  });

  await listener.start();

  // Graceful shutdown 핸들러 등록 (먼저 등록해야 시그널 수신 가능)
  const shutdown = async () => {
    console.log("\n종료 신호 수신...");
    await listener.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("=== Telegram Courier 실행 중 ===");

  // 프로세스를 살아있게 유지 (Railway/Docker 환경에서 필수)
  // 이 Promise는 절대 resolve되지 않으므로 프로세스가 계속 실행됨
  // SIGINT/SIGTERM 시그널로만 종료 가능
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("치명적 에러:", error);
  process.exit(1);
});
