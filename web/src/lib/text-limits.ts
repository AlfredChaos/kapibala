// 发送文本契约常量（T-P5-04；REQ §4 页面 3 发送表单、DES/05）。
// 真值在 server/src/constants.ts TEXT_MAX_LENGTH=2000——此处是 web 侧镜像，
// tests/group-page.test.tsx 直接 import 服务端常量做同源校验（卡片 d「与 TEXT_MAX_LENGTH 同源」）。
export const TEXT_MAX_LENGTH = 2000;

/** 发送表单前端校验（REQ §4：前端先做非空与 TEXT_MAX_LENGTH 校验——先于网络请求拦截） */
export function validateSendText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return '消息不能为空';
  if (text.length > TEXT_MAX_LENGTH) return `消息超长（${text.length}/${TEXT_MAX_LENGTH} 字）`;
  return null;
}
