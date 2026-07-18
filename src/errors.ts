/**
 * 可安全返回给客户端的输入错误。
 *
 * 只有明确由请求参数或用户配置引起的异常才使用此类型，避免把磁盘、网络等内部故障
 * 误报为 400，导致真正的服务问题被隐藏。
 */
export class ClientInputError extends Error {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ClientInputError';
  }
}

/** 管理后台在路由边界完成的参数校验错误。 */
export class AdminError extends ClientInputError {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

/** 运行时配置或 Key 管理操作中的用户输入错误。 */
export class RuntimeConfigError extends ClientInputError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

/** 管理端缺少 If-Match 时返回 428，防止无版本写入静默覆盖配置。 */
export class ConfigPreconditionError extends Error {
  public readonly statusCode = 428;

  constructor(message = '保存配置必须携带 If-Match。') {
    super(message);
    this.name = 'ConfigPreconditionError';
  }
}

/** 配置版本落后时返回 409，并让调用方使用 currentRevision 重新加载。 */
export class ConfigConflictError extends Error {
  public readonly statusCode = 409;

  constructor(
    message: string,
    public readonly currentRevision: number,
  ) {
    super(message);
    this.name = 'ConfigConflictError';
  }
}
