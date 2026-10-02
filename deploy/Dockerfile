FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/chat ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /bin/chat /chat
EXPOSE 8080
ENTRYPOINT ["/chat"]
