package handlers

import (
	"testing"
)

func TestTenantFilterRevenueMargin(t *testing.T) {
	paid := tenantRow{RevenueMicros: new(int64(18_300_000)), ContributionMicros: new(int64(12_300_000)), MarginPct: new(67.2)}
	loss := tenantRow{RevenueMicros: new(int64(9_200_000)), ContributionMicros: new(int64(-2_800_000)), MarginPct: new(-30.4)}
	trial := tenantRow{}

	cases := []struct {
		name string
		f    tenantFilter
		row  tenantRow
		want bool
	}{
		{"margin below 10: loss", tenantFilter{"margin", "less than", "10"}, loss, true},
		{"margin below 10: healthy", tenantFilter{"margin", "less than", "10"}, paid, false},
		{"margin above 50", tenantFilter{"margin", "more than", "50"}, paid, true},
		{"margin bound skips no-margin rows (less)", tenantFilter{"margin", "less than", "10"}, trial, false},
		{"margin bound skips no-margin rows (more)", tenantFilter{"margin", "more than", "-100"}, trial, false},
		{"revenue above 0: paying", tenantFilter{"revenue", "more than", "0"}, loss, true},
		{"revenue above 0 drops trials", tenantFilter{"revenue", "more than", "0"}, trial, false},
		{"revenue below 10: trial reads as $0", tenantFilter{"revenue", "less than", "10"}, trial, true},
		{"revenue below 10: $18.30", tenantFilter{"revenue", "less than", "10"}, paid, false},
		{"unparseable value is a no-op", tenantFilter{"margin", "less than", "abc"}, paid, true},
	}
	for _, tc := range cases {
		if got := tc.f.match(tc.row); got != tc.want {
			t.Errorf("%s: match = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestTenantMarginsWithoutLedger(t *testing.T) {
	m := (&TenantsHandler{}).tenantMargins(t.Context())
	if m.RevenueAvailable || m.RevenueError == "" {
		t.Errorf("no ledger: available %v, error %q", m.RevenueAvailable, m.RevenueError)
	}
}
