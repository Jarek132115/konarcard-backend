import { lazy } from "react";

export const lazyWithRetry = (factory, retries = 2, delay = 1000) =>
  lazy(() =>
    factory().catch((err) => {
      if (err?.name !== "ChunkLoadError") throw err;
      return new Promise((resolve, reject) => {
        let n = retries;
        const attempt = () =>
          factory().then(resolve).catch(e => (n-- > 0 ? setTimeout(attempt, delay) : reject(e)));
        attempt();
      });
    })
  );
