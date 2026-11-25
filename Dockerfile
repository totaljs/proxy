FROM node:24-alpine

LABEL org.opencontainers.image.title="Total.js Proxy" \
      org.opencontainers.image.description="Hostname routing and automatic HTTPS for your apps"

# Low ports without root
RUN apk add --no-cache libcap && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node && apk del libcap

WORKDIR /edge
COPY package.json index.js config ./
COPY lib ./lib
RUN mkdir -p /edge/data /edge/control && chown node:node /edge/data /edge/control && chmod 700 /edge/data

USER node
VOLUME /edge/data /edge/control
EXPOSE 80 443 53/udp 53/tcp

# More threads for the files and the crypto of the edge (names are resolved apart, see lib/proxy.js)
ENV UV_THREADPOOL_SIZE=16

CMD ["node", "index.js", "config"]
