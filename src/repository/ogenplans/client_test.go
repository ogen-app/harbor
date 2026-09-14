package ogenplans

import (
	"testing"

	"google.golang.org/protobuf/types/known/structpb"

	plansv1 "github.com/ogen-app/harbor/gen/plans/v1"
)

// The proto entitlements field is optional. versionFromProto must normalise an
// omitted field to a non-nil empty map (never nil), so the JSON API emits {}
// and never null — a null would throw in the matrix UI's cell lookup.
func TestVersionFromProto_NilEntitlementsIsEmptyMap(t *testing.T) {
	got := versionFromProto(&plansv1.TierVersion{Id: "v1"})
	if got.Entitlements == nil {
		t.Fatal("entitlements = nil, want non-nil empty map so the API never emits JSON null")
	}
	if len(got.Entitlements) != 0 {
		t.Errorf("entitlements = %v, want empty", got.Entitlements)
	}
	if got.Prices == nil {
		t.Error("prices = nil, want non-nil empty slice")
	}
}

// A populated entitlements Struct round-trips: numbers decode to float64 and a
// null value (an unlimited numeric) is preserved as a present nil entry.
func TestVersionFromProto_EntitlementsRoundTrip(t *testing.T) {
	s, err := structpb.NewStruct(map[string]any{"team_seats": 3, "workspaces": nil})
	if err != nil {
		t.Fatalf("NewStruct: %v", err)
	}
	got := versionFromProto(&plansv1.TierVersion{Id: "v1", Entitlements: s})
	if v, ok := got.Entitlements["team_seats"]; !ok || v != float64(3) {
		t.Errorf("team_seats = %v (ok=%v), want 3", v, ok)
	}
	if v, ok := got.Entitlements["workspaces"]; !ok || v != nil {
		t.Errorf("workspaces = %v (ok=%v), want present nil (unlimited)", v, ok)
	}
}
