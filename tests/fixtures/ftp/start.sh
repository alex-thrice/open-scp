#!/bin/sh
set -eu

adduser -D -h /home/fixture fixture
echo 'fixture:fixture-ftp-password-only' | chpasswd
mkdir -p '/home/fixture/data/Unicode каталог' '/home/fixture/data/restricted'
printf '%s\n' 'Disposable FTP fixture.' >'/home/fixture/data/file with spaces.txt'
printf '%s\n' 'UTF-8 fixture.' >'/home/fixture/data/Unicode каталог/пример.txt'
chown -R fixture:fixture /home/fixture/data
chmod 000 /home/fixture/data/restricted

exec /usr/sbin/vsftpd /etc/vsftpd/vsftpd.conf
