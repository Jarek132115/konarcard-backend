import React from "react";

/**
 * lazyWithRetry(factory, retries=2, delay=1000)
 * Retries loading a dynamic import when the chunk fails to load
 * (most commonly after a fresh deploy while a user has an old tab open).
 */
export const lazyWithRetry = (factory, retries = 2, delay = 1000) => {
    return React.lazy(() =>
        factory().catch((err) => {
            // Only retry for classic chunk/network load failures
            const name = err?.name || "";
            const msg = String(err?.message || "");
            const isChunkError =
                name === "ChunkLoadError" ||
                /Loading chunk \d+ failed/i.test(msg) ||
                /Failed to fetch dynamically imported module/i.test(msg) ||
                /Importing a module script failed/i.test(msg);

            if (!isChunkError) throw err;

            return new Promise((resolve, reject) => {
                let attempts = retries;

                const retry = () => {
                    factory().then(resolve).catch((e) => {
                        if (attempts-- > 0) {
                            setTimeout(retry, delay);
                        } else {
                            reject(e);
                        }
                    });
                };

                retry();
            });
        })
    );
};
