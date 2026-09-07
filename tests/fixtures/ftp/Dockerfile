FROM alpine:3.22.1

RUN apk add --no-cache vsftpd

COPY ftp/vsftpd.conf /etc/vsftpd/vsftpd.conf
COPY ftp/start.sh /start.sh

RUN chmod 0755 /start.sh

EXPOSE 21 30000-30009

ENTRYPOINT ["/start.sh"]
