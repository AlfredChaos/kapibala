// GET /media/:id（T-P3-09 充实，此前是恒 404 存根）+ gw-27 两开关的媒体侧实现。
// 契约出处：REQ §2.1「`mediaUrl`（可选）指向网关的 `GET /media/:id`，返回文件字节，**过期后返回 404**」；
// DES/14 §5 行 27（`media_message` / `media_expire_404`）。消费方：server 侧 C1（T-P8-01）下载字节存盘。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayState, MockMediaObject } from './state.js';
import { activeSwitch, readNumberParam, type SwitchTarget } from './switches.js';

/** mock 自造确定性内容（SVG 文本字节）：server 侧只按字节存盘、不解码 */
const MEDIA_CONTENT_TYPE = 'image/svg+xml';

/** 确定性文件字节：同 mediaId 恒同内容，且内容里带 mediaId（断言「下到的正是这一个文件」用） */
function mediaBytes(mediaId: string): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" data-media-id="${mediaId}">` +
      '<rect width="8" height="8" fill="#4b3f3f" /></svg>',
  );
}

/** gw-27 `media_message`：这次落地的 message 事件是否要带 mediaUrl（按 send 的 target 收窄） */
export function isMediaMessageEnabled(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'media_message', target) !== undefined;
}

/**
 * 建媒体对象并返回 message 事件要带的 **绝对** mediaUrl。
 * mediaId 与 msgId 同名（可追溯：server 侧 C1 把字节存成 `media/<msgId>`）；绝对 URL 是消费方契约
 * ——server 的 `downloadMedia(mediaUrl)` 直接 fetch，不做 base 拼接。
 */
export function attachMedia(state: GatewayState, msgId: string, origin: string): string {
  state.media.set(msgId, { bytes: mediaBytes(msgId), contentType: MEDIA_CONTENT_TYPE, createdAt: Date.now() });
  return `${origin}/media/${msgId}`;
}

/** 请求 origin（Host 头含端口）；无 Host 时退到本机 + PORT（DES/14 §6 默认 :4100） */
export function requestOrigin(request: FastifyRequest): string {
  const host = request.headers['host'];
  if (typeof host === 'string' && host !== '') {
    return `http://${host}`;
  }
  return `http://localhost:${process.env['PORT'] ?? 4100}`;
}

/**
 * 过期判定（gw-27 `media_expire_404`）：开关命中该媒体（全局 arm 或按 `target.mediaId` 收窄），
 * 且距创建时刻已过 `params.afterMs`（缺省 0 = arm 即过期）。clear 开关 = 撤销过期安排
 * （与 gw-11/12 的终态标志同构：arrange 可撤销，不留下不可解释的残状态）。
 */
export function isMediaExpired(state: GatewayState, mediaId: string, media: MockMediaObject): boolean {
  const config = activeSwitch(state, 'media_expire_404', { mediaId });
  if (config === undefined) {
    return false;
  }
  return Date.now() >= media.createdAt + (readNumberParam(config, 'afterMs') ?? 0);
}

export function registerMediaRoutes(app: FastifyInstance, state: GatewayState): void {
  // GET /media/:mediaId → 200 文件字节（带 content-type）/ 404（不存在或已过期，REQ §2.1）
  app.get('/media/:mediaId', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string };
    const media = state.media.get(mediaId);
    if (media === undefined) {
      return reply.code(404).send({ message: 'media not found' });
    }
    if (isMediaExpired(state, mediaId, media)) {
      return reply.code(404).send({ message: 'media expired' });
    }
    return reply.header('content-type', media.contentType).send(Buffer.from(media.bytes));
  });
}
