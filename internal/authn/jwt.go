// Package authn JWT 签发与校验。
package authn

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var ErrInvalidToken = errors.New("invalid token")

// Claims 是 JWT 载荷。
type Claims struct {
	UserID string `json:"uid"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

type Service struct {
	secret []byte
	ttl    time.Duration
}

func New(secret string, ttl time.Duration) *Service {
	return &Service{secret: []byte(secret), ttl: ttl}
}

// Issue 为登录成功的用户签发 JWT。
func (s *Service) Issue(userID, name string) (token string, expiresAt int64, err error) {
	now := time.Now()
	exp := now.Add(s.ttl)
	claims := Claims{
		UserID: userID,
		Name:   name,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	token, err = jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	return token, exp.Unix(), err
}

// Verify 校验 token 并返回载荷。
func (s *Service) Verify(tokenStr string) (*Claims, error) {
	if tokenStr == "" {
		return nil, ErrInvalidToken
	}
	var claims Claims
	tok, err := jwt.ParseWithClaims(tokenStr, &claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return s.secret, nil
	})
	if err != nil || !tok.Valid {
		return nil, ErrInvalidToken
	}
	return &claims, nil
}
