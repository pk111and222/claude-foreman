import { LANGUAGE } from '../util.mjs';

// health 的地址、身份字段和口令格式跨版本保持可识别；不兼容的改动才增加版本。
export const BOARD_PROTOCOL = 1;
export const boardAddressValid = (lock) => Number.isInteger(lock?.port) && lock.port > 0 && lock.port <= 65535
  && typeof lock.token === 'string' && /^[a-f0-9]{32}$/.test(lock.token);
export const boardUrl = (lock, session = null) =>
  `http://127.0.0.1:${lock.port}/${lock.token}/?level=all&lang=${encodeURIComponent(LANGUAGE)}${session ? `&s=${encodeURIComponent(session)}` : ''}`;
