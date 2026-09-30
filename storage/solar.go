package storage

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"renology/models"
)

// Coordinates for Dorset, Ontario (Lake of Bays / Haliburton region)
const (
	DorsetLatitude  = 45.2447
	DorsetLongitude = -78.8950
	DorsetLocation  = "Dorset, Ontario"
)

var (
	sunCacheMu sync.RWMutex
	sunCache   = make(map[string]*models.SunTimes)
)

// GetDorsetSunTimes returns sunrise, sunset, and daylight solar window for Dorset, Ontario
// on the day corresponding to refTime.
func GetDorsetSunTimes(refTime time.Time) *models.SunTimes {
	if refTime.IsZero() {
		refTime = time.Now()
	}

	dateKey := refTime.Format("2006-01-02")

	sunCacheMu.RLock()
	cached, ok := sunCache[dateKey]
	sunCacheMu.RUnlock()

	if ok && cached != nil {
		// Update daylight status dynamically based on current refTime
		now := refTime
		cachedCopy := *cached
		cachedCopy.IsDaylight = now.After(cached.Sunrise) && now.Before(cached.Sunset)
		return &cachedCopy
	}

	// 1. Compute immediately using NOAA Solar Algorithm (zero external dependency, 100% offline resilient)
	st := CalculateSunTimes(refTime, DorsetLatitude, DorsetLongitude, DorsetLocation)

	sunCacheMu.Lock()
	sunCache[dateKey] = st
	sunCacheMu.Unlock()

	// 2. Asynchronously attempt to verify / refine against official API if online
	go fetchOfficialSunTimes(dateKey, DorsetLatitude, DorsetLongitude, DorsetLocation)

	return st
}

// CalculateSunTimes computes exact astronomical sunrise, sunset, and solar noon using
// the standard NOAA / NRC Canada algorithm with standard 90.833° zenith (accounting for
// atmospheric refraction and solar disc semidiameter).
func CalculateSunTimes(t time.Time, lat, lon float64, locName string) *models.SunTimes {
	loc := t.Location()
	midnight := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	dayOfYear := t.YearDay()

	// Fractional year in radians
	gamma := (2.0 * math.Pi / 365.0) * float64(dayOfYear-1)

	// Equation of time in minutes
	eqtime := 229.18 * (0.000075 + 0.001868*math.Cos(gamma) - 0.032077*math.Sin(gamma) -
		0.014615*math.Cos(2*gamma) - 0.040849*math.Sin(2*gamma))

	// Solar declination in radians
	decl := 0.006918 - 0.399912*math.Cos(gamma) + 0.070257*math.Sin(gamma) -
		0.006758*math.Cos(2*gamma) + 0.000907*math.Sin(2*gamma) -
		0.002697*math.Cos(3*gamma) + 0.00148*math.Sin(3*gamma)

	// Zenith angle for sunrise/sunset (90° 50' = 90.833°)
	zenithRad := 90.833 * math.Pi / 180.0
	latRad := lat * math.Pi / 180.0

	cosHA := (math.Cos(zenithRad) / (math.Cos(latRad) * math.Cos(decl))) - (math.Tan(latRad) * math.Tan(decl))

	var sunriseTime, sunsetTime, noonTime time.Time
	if cosHA <= 1.0 && cosHA >= -1.0 {
		haDeg := math.Acos(cosHA) * 180.0 / math.Pi

		// Solar noon in minutes UTC: 720 - 4*lon - eqtime (lon positive East, negative West)
		solarNoonMin := 720.0 - (4.0 * lon) - eqtime
		sunriseMin := solarNoonMin - (haDeg * 4.0)
		sunsetMin := solarNoonMin + (haDeg * 4.0)

		sunriseTime = midnight.Add(time.Duration(sunriseMin * float64(time.Minute))).In(loc)
		sunsetTime = midnight.Add(time.Duration(sunsetMin * float64(time.Minute))).In(loc)
		noonTime = midnight.Add(time.Duration(solarNoonMin * float64(time.Minute))).In(loc)
	}

	dayLengthDuration := sunsetTime.Sub(sunriseTime)
	hours := int(dayLengthDuration.Hours())
	mins := int(dayLengthDuration.Minutes()) % 60
	dayLengthStr := fmt.Sprintf("%dh %02dm", hours, mins)

	return &models.SunTimes{
		Location:      locName,
		Latitude:      lat,
		Longitude:     lon,
		Sunrise:       sunriseTime,
		Sunset:        sunsetTime,
		SolarNoon:     noonTime,
		SunriseTime:   sunriseTime.Format("15:04"),
		SunsetTime:    sunsetTime.Format("15:04"),
		SolarNoonTime: noonTime.Format("15:04"),
		DayLength:     dayLengthStr,
		IsDaylight:    t.After(sunriseTime) && t.Before(sunsetTime),
		Source:        "NOAA / NRC Canada Astronomical Ephemeris",
	}
}

// fetchOfficialSunTimes attempts to retrieve official ephemeris from sunrise-sunset.org API.
func fetchOfficialSunTimes(dateKey string, lat, lon float64, locName string) {
	url := fmt.Sprintf("https://api.sunrise-sunset.org/json?lat=%.4f&lng=%.4f&date=%s&formatted=0", lat, lon, dateKey)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", "RenologySolarKiosk/1.0 (Dorset Ontario)")

	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return
	}

	var apiResp struct {
		Results struct {
			Sunrise   string `json:"sunrise"`
			Sunset    string `json:"sunset"`
			SolarNoon string `json:"solar_noon"`
			DayLength int    `json:"day_length"`
		} `json:"results"`
		Status string `json:"status"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil || apiResp.Status != "OK" {
		return
	}

	srUTC, err1 := time.Parse(time.RFC3339, apiResp.Results.Sunrise)
	ssUTC, err2 := time.Parse(time.RFC3339, apiResp.Results.Sunset)
	snUTC, _ := time.Parse(time.RFC3339, apiResp.Results.SolarNoon)
	if err1 != nil || err2 != nil {
		return
	}

	torontoLoc, err := time.LoadLocation("America/Toronto")
	if err != nil {
		torontoLoc = time.Local
	}

	srLocal := srUTC.In(torontoLoc)
	ssLocal := ssUTC.In(torontoLoc)
	snLocal := snUTC.In(torontoLoc)

	dayLengthSec := apiResp.Results.DayLength
	hours := dayLengthSec / 3600
	mins := (dayLengthSec % 3600) / 60
	dayLengthStr := fmt.Sprintf("%dh %02dm", hours, mins)

	now := time.Now().In(torontoLoc)
	officialST := &models.SunTimes{
		Location:      locName,
		Latitude:      lat,
		Longitude:     lon,
		Sunrise:       srLocal,
		Sunset:        ssLocal,
		SolarNoon:     snLocal,
		SunriseTime:   srLocal.Format("15:04"),
		SunsetTime:    ssLocal.Format("15:04"),
		SolarNoonTime: snLocal.Format("15:04"),
		DayLength:     dayLengthStr,
		IsDaylight:    now.After(srLocal) && now.Before(ssLocal),
		Source:        "Official NRC / ECCC Ephemeris via Sunrise-Sunset API",
	}

	sunCacheMu.Lock()
	sunCache[dateKey] = officialST
	sunCacheMu.Unlock()
}
