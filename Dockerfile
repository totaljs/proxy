FROM node:24-alpine

LABEL org.opencontainers.image.title="Total.js Proxy" \
      org.opencontainers.image.description="Hostname routing and automatic HTTPS for your apps"

# Low ports without root
RUN apk add --no-cache libcap && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node && apk del libcap

WORKDIR /proxy
COPY package.json index.js ./
COPY lib ./lib
RUN mkdir -p /proxy/data /proxy/logs && chown node:node /proxy/data /proxy/logs && chmod 700 /proxy/data /proxy/logs

USER node
VOLUME /proxy/data /proxy/logs
EXPOSE 80 443 53/udp 53/tcp

# More threads for the files and the crypto of Proxy (names are resolved apart, see lib/proxy.js)
ENV UV_THREADPOOL_SIZE=16

CMD ["node", "index.js", "data"]
