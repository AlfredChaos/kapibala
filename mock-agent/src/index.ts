// 占位入口（T-P0-01）：mock-agent 的 Fastify 应用与 scripted/anthropic 双 provider 归 T-P4-01。
// 此刻仅保持 dev 进程存活并打就绪日志（不占用端口，避免与正式实现抢 4200）。
const PORT = Number(process.env.PORT ?? 4200);

console.log(`[mock-agent] placeholder entry (PORT=${PORT}); Fastify app + providers land in T-P4-01`);

// 悬空定时器保活：占位阶段无服务可跑，维持进程存在即可
setInterval(() => {}, 60_000);
