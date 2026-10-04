export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

export class AppError extends Error {
  constructor(
    readonly status: ErrorStatus,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(400, message);
export const forbidden = (message: string) => new AppError(403, message);
export const notFound = (message: string) => new AppError(404, message);
export const conflict = (message: string) => new AppError(409, message);
export const unauthorized = (message = '未登录或登录已过期') => new AppError(401, message);
