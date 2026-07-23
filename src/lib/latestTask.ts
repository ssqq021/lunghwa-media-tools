export class StaleTaskError extends Error {
  constructor() {
    super('任务已被更新的操作取代。');
    this.name = 'StaleTaskError';
  }
}

export type LatestTaskTracker = {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (token: number) => boolean;
  assertCurrent: (token: number) => void;
};

export function createLatestTaskTracker(): LatestTaskTracker {
  let currentToken = 0;

  return {
    begin: () => {
      currentToken += 1;
      return currentToken;
    },
    invalidate: () => {
      currentToken += 1;
    },
    isCurrent: (token) => token === currentToken,
    assertCurrent: (token) => {
      if (token !== currentToken) {
        throw new StaleTaskError();
      }
    },
  };
}

export function isStaleTaskError(error: unknown): error is StaleTaskError {
  return error instanceof StaleTaskError;
}
