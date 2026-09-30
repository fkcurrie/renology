package storage

import (
	"testing"
	"time"
)

func TestCalculateSunTimesDorset(t *testing.T) {
	torontoLoc, err := time.LoadLocation("America/Toronto")
	if err != nil {
		torontoLoc = time.FixedZone("EDT", -4*3600)
	}

	// Test Fall Equinox / Late September in Dorset, Ontario
	refTime := time.Date(2026, 9, 30, 12, 0, 0, 0, torontoLoc)
	st := CalculateSunTimes(refTime, DorsetLatitude, DorsetLongitude, DorsetLocation)

	if st == nil {
		t.Fatalf("expected non-nil SunTimes")
	}

	if st.Location != "Dorset, Ontario" {
		t.Errorf("expected location 'Dorset, Ontario', got %s", st.Location)
	}

	// On Sep 30 in Dorset, sunrise is expected between 07:05 and 07:15 EDT
	srHour := st.Sunrise.Hour()
	if srHour != 7 {
		t.Errorf("expected sunrise hour 7, got %d (%s)", srHour, st.SunriseTime)
	}

	// On Sep 30 in Dorset, sunset is expected between 18:55 and 19:05 EDT
	ssHour := st.Sunset.Hour()
	if ssHour != 18 && ssHour != 19 {
		t.Errorf("expected sunset hour 18 or 19, got %d (%s)", ssHour, st.SunsetTime)
	}

	// Solar noon should be around 13:00 - 13:10 EDT
	snHour := st.SolarNoon.Hour()
	if snHour != 13 {
		t.Errorf("expected solar noon hour 13, got %d (%s)", snHour, st.SolarNoonTime)
	}

	// Day length should be approx 11h 45m - 11h 55m
	if st.DayLength == "" {
		t.Errorf("expected non-empty DayLength")
	}
}

func TestGetDorsetSunTimes(t *testing.T) {
	st := GetDorsetSunTimes(time.Now())
	if st == nil {
		t.Fatalf("expected non-nil SunTimes from GetDorsetSunTimes")
	}
	if st.SunriseTime == "" || st.SunsetTime == "" {
		t.Errorf("expected formatted sunrise and sunset times, got %s / %s", st.SunriseTime, st.SunsetTime)
	}
}
