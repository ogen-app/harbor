// Package models holds the bun-mapped domain types.
package models

import (
	"time"

	"github.com/uptrace/bun"
)

// User is a Google-authenticated operator. google_sub is Google's stable
// account identifier and the upsert key; email is the allowlist key.
type User struct {
	bun.BaseModel `bun:"table:users,alias:u"`

	ID        string    `bun:"id,pk"                                        json:"id"`
	GoogleSub string    `bun:"google_sub,notnull"                           json:"-"`
	Email     string    `bun:"email,notnull"                                json:"email"`
	Name      string    `bun:"name,notnull"                                 json:"name"`
	Picture   string    `bun:"picture,notnull"                              json:"picture"`
	CreatedAt time.Time `bun:"created_at,notnull,default:current_timestamp" json:"created_at"`
	UpdatedAt time.Time `bun:"updated_at,notnull,default:current_timestamp" json:"updated_at"`
}
