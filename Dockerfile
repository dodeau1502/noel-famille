# Image du serveur « Liste de Noël » (page + fonctions + relais). Version de Deno épinglée.
ARG DENO_VERSION=2.9.6
FROM denoland/deno:${DENO_VERSION}
WORKDIR /app
COPY server ./server
COPY supabase/functions ./supabase/functions
COPY site ./site
RUN deno cache server/main.ts
USER deno
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8000/healthz'); Deno.exit(r.ok ? 0 : 1)"]
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=site", "server/main.ts"]
