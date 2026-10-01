package storage

import (
	"fmt"
	"math"
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

// isLeapYear returns true if the specified calendar year is a leap year.
func isLeapYear(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}

// GetDorsetSunTimes returns sunrise, sunset, and daylight solar window for Dorset, Ontario
// on the day corresponding to refTime using the NOAA astronomical algorithm.
func GetDorsetSunTimes(refTime time.Time) *models.SunTimes {
	if refTime.IsZero() {
		refTime = time.Now()
	}

	dateKey := refTime.Format("2006-01-02")

	sunCacheMu.RLock()
	cached, ok := sunCache[dateKey]
	var cachedCopy models.SunTimes
	if ok && cached != nil {
		cachedCopy = *cached
	}
	sunCacheMu.RUnlock()

	if ok && cached != nil {
		// Update daylight status dynamically based on current refTime
		now := refTime
		cachedCopy.IsDaylight = now.After(cachedCopy.Sunrise) && now.Before(cachedCopy.Sunset)
		return &cachedCopy
	}

	// Compute immediately using NOAA Solar Algorithm (zero external dependency, 100% offline resilient)
	st := CalculateSunTimes(refTime, DorsetLatitude, DorsetLongitude, DorsetLocation)

	sunCacheMu.Lock()
	sunCache[dateKey] = st
	sunCacheMu.Unlock()

	return st
}

// CalculateSunTimes computes exact astronomical sunrise, sunset, and solar noon using
// the standard NOAA / NRC Canada algorithm with standard 90.833° zenith (accounting for
// atmospheric refraction and solar disc semidiameter).
func CalculateSunTimes(t time.Time, lat, lon float64, locName string) *models.SunTimes {
	loc := t.Location()
	midnight := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	dayOfYear := t.YearDay()

	// Fractional year in radians (accounting for leap years)
	daysInYear := 365.0
	if isLeapYear(t.Year()) {
		daysInYear = 366.0
	}
	gamma := (2.0 * math.Pi / daysInYear) * float64(dayOfYear-1)

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
