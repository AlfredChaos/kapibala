# AGENTS.md — mock-agent

Agent 服务模拟包（根 [AGENTS.md](../AGENTS.md) 的就近覆盖，只写本包特有内容）。

- 默认实例 `:4200`，`AGENT_MODE=scripted`；anthropic（C2 真实 LLM）独立实例 `:4300`，单包双 provider（DES/12）。
- `ANTHROPIC_API_KEY` 只进本地 `.env`，绝不提交（根 §5）。
- server 侧切换形态只改 `AGENT_URL`（DES/12 §8）；后端测试默认用 scripted。
- Agent 协议形状以 `@kapibala/contract`（T-P0-02 填充）与 `docs/analysis/03-agent-contract.md` 为准。
