export class AuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthError";
  }
}

// Playwright errors can include fill values, URLs and page contents. Never log them.
export function publicError(error: unknown): { status: string; message: string } {
  if (error instanceof AuthError) return { status: error.code, message: error.message };
  return {
    status: "AUTH_ERROR",
    message: "로그인 작업을 완료하지 못했습니다. 브라우저 설치와 네트워크 상태를 확인해 주세요.",
  };
}
