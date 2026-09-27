// 占位入口（T-P0-01）：mock-gateway 的 Fastify 应用与 /_test 控制平面归 T-P1-01。
// 此刻仅保持 dev 进程存活并打就绪日志（不占用端口，避免与正式实现抢 4100）。
const PORT = Number(process.env.PORT ?? 4100);

console.log(`[mock-gateway] placeholder entry (PORT=${PORT}); Fastify app + /_test plane land in T-P1-01`);

// 悬空定时器保活：占位阶段无服务可跑，维持进程存在即可
setInterval(() => {}, 60_000);
