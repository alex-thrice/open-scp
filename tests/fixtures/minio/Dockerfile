FROM golang:1.24.7-alpine3.22 AS build

ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2

# Keep the fixture versions unchanged and pin the upstream source commits.
# MinIO RELEASE.2025-09-07T16-13-09Z; mc RELEASE.2025-08-13T08-35-41Z.
RUN go install -trimpath -ldflags="-s -w" github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb
RUN go install -trimpath -ldflags="-s -w" github.com/minio/mc@7394ce0dd2a80935aded936b09fa12cbb3cb8096
RUN mkdir -p /licenses/minio /licenses/mc \
    && minio_source="$(go list -m -f '{{.Dir}}' github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb)" \
    && cp "$minio_source/LICENSE" "$minio_source/CREDITS" /licenses/minio/ \
    && mc_source="$(go list -m -f '{{.Dir}}' github.com/minio/mc@7394ce0dd2a80935aded936b09fa12cbb3cb8096)" \
    && cp "$mc_source/LICENSE" "$mc_source/CREDITS" /licenses/mc/

FROM alpine:3.22.1 AS runtime

RUN apk add --no-cache ca-certificates curl

FROM runtime AS server

COPY --from=build /go/bin/minio /usr/local/bin/minio
COPY --from=build /licenses/minio /licenses/minio

ENTRYPOINT ["minio"]

FROM runtime AS client

COPY --from=build /go/bin/mc /usr/local/bin/mc
COPY --from=build /licenses/mc /licenses/mc

ENTRYPOINT ["mc"]
