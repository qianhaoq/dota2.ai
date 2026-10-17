/**
 * JSON 请求体错误处理（QA P2）：express.json() 解析失败时 Express 默认回
 * HTML "Bad Request" 页面，API 客户端拿到的是 HTML 而不是 JSON。这里按
 * body-parser 的 err.type 分类返回结构化 JSON 错误：
 * - entity.parse.failed → 400 { error: 'invalid_json', message: 本地化 }
 * - entity.too.large    → 413 { error: 'payload_too_large', message: 本地化 }
 * 其余错误原样 next(err)。绝不回显请求体或 err.message（可能引用原始内容）。
 * zh 条件：query `lang=zh`（zh-* 同样接受）或 Accept-Language 以 zh 开头。
 */

const INVALID_JSON_MESSAGE = {
  en: 'Request body is not valid JSON',
  zh: '请求体不是合法的 JSON',
};

const PAYLOAD_TOO_LARGE_MESSAGE = {
  en: 'Request body is too large',
  zh: '请求体过大',
};

/**
 * @param {unknown} req Express request（测试里可为 mock 对象）
 * @returns {'zh' | 'en'}
 */
function jsonBodyErrorLang(req) {
  const queryLang = req?.query?.lang;
  if (typeof queryLang === 'string' && queryLang.trim().toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  const acceptLanguage = req?.headers?.['accept-language'];
  if (typeof acceptLanguage === 'string' && acceptLanguage.trim().toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

/**
 * Express error handler（4 参签名），紧跟 app.use(express.json()) 注册：
 * 只接住 body-parser 抛出的解析/体积错误，其余 next(err) 交给后续处理。
 * @param {unknown} err
 * @param {any} req
 * @param {any} res
 * @param {(err?: unknown) => void} next
 */
export function jsonBodyErrorHandler(err, req, res, next) {
  if (!err || typeof err !== 'object') return next(err);
  if (err.type === 'entity.parse.failed') {
    const lang = jsonBodyErrorLang(req);
    return res.status(400).json({
      error: 'invalid_json',
      message: INVALID_JSON_MESSAGE[lang],
    });
  }
  if (err.type === 'entity.too.large') {
    const lang = jsonBodyErrorLang(req);
    return res.status(413).json({
      error: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_MESSAGE[lang],
    });
  }
  return next(err);
}
