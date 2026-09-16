# LLMSwapper - imagen única para hosts Linux, macOS y Windows.
#
# El contenedor es SIEMPRE Linux; lo que cambia según el host es qué se puede montar y qué deja
# de funcionar. Está documentado en el README, y el propio panel lo dice en pantalla en vez de
# fingir que todo va bien: dentro de un contenedor no se ven los procesos del host (así que no
# puede saber si Claude Code está abierto) ni existe wsl.exe (así que no hay targets de WSL).
#
# node:22-alpine es multiarquitectura, así que la misma receta produce amd64 y arm64 - esto
# último importa: sin arm64 la imagen correría emulada en los Mac con Apple Silicon.
# Publicar ambas:  docker buildx build --platform linux/amd64,linux/arm64 -t llmswapper .
FROM node:22-alpine

# Cero dependencias: no hay npm install, ni build, ni capa de node_modules que cachear.
# Por eso no hay multi-stage - no habría nada que dejar fuera de la segunda etapa.
WORKDIR /app

COPY package.json ./
COPY server.js test.js ./
COPY lib/ ./lib/
COPY public/ ./public/

# Sello de build. Un `docker compose up -d` sin --build reutiliza la imagen anterior sin decir
# nada, y desde fuera no hay forma de saber qué código corre: el panel lo enseña en el aviso de
# contenedor y /api/health lo devuelve. Va DETRÁS de los COPY para que la caché lo regenere
# exactamente cuando cambia el código, y nunca antes.
RUN date -u +%Y-%m-%dT%H:%MZ > /app/.build

# Lo lee lib/paths.inContainer(). /.dockerenv basta para Docker, pero no para Podman ni para
# algunos runtimes de Kubernetes, así que se declara explícitamente y no se deja a la deducción.
ENV SWAPPER_IN_CONTAINER=1
# 127.0.0.1 dentro del contenedor sería inalcanzable desde el host: hay que escuchar en todas
# las interfaces DEL CONTENEDOR. La propiedad de seguridad se conserva fuera, publicando el
# puerto solo en el loopback del host:  -p 127.0.0.1:7373:7373
ENV SWAPPER_BIND=0.0.0.0
ENV PORT=7373
# Sin esto el servidor intenta abrir un navegador que no existe en la imagen.
ENV NO_OPEN=1

# El directorio tiene que existir Y pertenecer a node ANTES del VOLUME: al crear un volumen con
# nombre por primera vez, Docker copia dueño y permisos de la ruta en la imagen. Sin esto el
# volumen nace de root, el proceso corre como node, y el arranque muere con
# EACCES: permission denied, mkdir '/app/data/backups'. Solo vale para volúmenes con nombre: un
# bind mount (./data en el compose) trae el dueño del host, así que ahí data/ tiene que existir ya.
RUN mkdir -p /app/data && chown -R node:node /app

# data/ guarda tokens vivos. Declararlo como volumen evita que acabe en una capa de la imagen
# si alguien hace commit del contenedor, y hace evidente que hay estado que persistir.
VOLUME ["/app/data"]

# uid 1000 es el primer usuario en la mayoría de distros Linux, así que los ficheros montados
# suelen coincidir. Cuando no coincidan:  --user "$(id -u):$(id -g)"
# HOME fijo: con --user, un uid que no está en /etc/passwd arranca con HOME=/ y el servidor
# buscaría /.claude.json y /.claude en vez de lo montado en /home/node.
ENV HOME=/home/node
USER node

EXPOSE 7373

# La API exige su propia cabecera en TODA petición, /api/health incluido - de ahí el --header.
HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- --header='X-Swapper: 1' "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server.js"]
