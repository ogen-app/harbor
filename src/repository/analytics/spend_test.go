package analytics

import "testing"

func TestAddVendorCostClassification(t *testing.T) {
	var s VendorSpend
	AddVendorCost(&s, "anthropic", 10)
	AddVendorCost(&s, "Claude-3-Opus", 5) // matches "claude"
	AddVendorCost(&s, "google-vertex", 7) // matches "google"/"vertex"
	AddVendorCost(&s, "gemini-1.5", 3)    // matches "gemini"
	AddVendorCost(&s, "openai", 4)        // → other
	AddVendorCost(&s, "  ", 1)            // blank → other

	if s.AnthropicMicros != 15 {
		t.Errorf("anthropic = %d, want 15", s.AnthropicMicros)
	}
	if s.GoogleMicros != 10 {
		t.Errorf("google = %d, want 10", s.GoogleMicros)
	}
	if s.OtherMicros != 5 {
		t.Errorf("other = %d, want 5", s.OtherMicros)
	}
	if s.TotalMicros != 30 {
		t.Errorf("total = %d, want 30", s.TotalMicros)
	}
}
