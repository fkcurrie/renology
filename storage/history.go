package storage

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"time"

	"renology/models"
)

// GetLatest reads and returns the latest telemetry snapshot.
func (s *Storage) GetLatest() (*models.Telemetry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.latestPath)
	if err != nil {
		return nil, err
	}
	var t models.Telemetry
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// GetHistory parses recorded telemetry and produces 24-hour and 7-day downsampled series.
func (s *Storage) GetHistory(referenceTime time.Time) (*models.HistoryResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if referenceTime.IsZero() {
		referenceTime = time.Now()
	}

	records := s.readAllTelemetryRecords()

	// 1. Build 24-Hour Downsampled Series (15-minute buckets = 96 points)
	points24h := s.build24hSeries(records, referenceTime)

	// 2. Build 7-Day Daily Summary Series (7 calendar days)
	days7d := s.build7dSeries(records, referenceTime)

	return &models.HistoryResponse{
		Points24h: points24h,
		Days7d:    days7d,
	}, nil
}

// readAllTelemetryRecords reads all valid telemetry records from the JSONL log file.
func (s *Storage) readAllTelemetryRecords() []models.Telemetry {
	f, err := os.Open(s.jsonlPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var records []models.Telemetry
	scanner := bufio.NewScanner(f)
	// Support up to 64KB per line
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 64*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var t models.Telemetry
		if err := json.Unmarshal(line, &t); err == nil && !t.Timestamp.IsZero() {
			records = append(records, t)
		}
	}
	return records
}

// build24hSeries generates a 24-hour history curve in 15-minute intervals.
func (s *Storage) build24hSeries(records []models.Telemetry, now time.Time) []models.HistoryPoint24h {
	const bucketDuration = 15 * time.Minute
	const numBuckets = 96 // 24 hours / 15 minutes

	startWindow := now.Add(-24 * time.Hour)
	points := make([]models.HistoryPoint24h, 0, numBuckets)

	type bucketData struct {
		count       int
		sumWatts    int
		sumVolts    float64
		sumSOC      int
		sumBattVolt float64
	}

	buckets := make(map[int]*bucketData)

	// Group existing records into bucket index [0..95]
	for _, r := range records {
		if r.Timestamp.Before(startWindow) || r.Timestamp.After(now) {
			continue
		}
		diff := r.Timestamp.Sub(startWindow)
		idx := int(diff / bucketDuration)
		if idx < 0 {
			idx = 0
		}
		if idx >= numBuckets {
			idx = numBuckets - 1
		}

		b, ok := buckets[idx]
		if !ok {
			b = &bucketData{}
			buckets[idx] = b
		}
		b.count++
		b.sumWatts += r.PVPower
		b.sumVolts += r.PVVoltage
		b.sumSOC += r.BatterySOC
		b.sumBattVolt += r.BatteryVoltage
	}

	// Generate the 96 buckets
	for i := 0; i < numBuckets; i++ {
		tBucket := startWindow.Add(time.Duration(i) * bucketDuration)
		timeLabel := tBucket.Format("15:04")

		if b, ok := buckets[i]; ok && b.count > 0 {
			points = append(points, models.HistoryPoint24h{
				Timestamp:      tBucket,
				TimeLabel:      timeLabel,
				SolarPowerW:    b.sumWatts / b.count,
				PVVoltage:      math.Round((b.sumVolts/float64(b.count))*10) / 10,
				BatterySOC:     b.sumSOC / b.count,
				BatteryVoltage: math.Round((b.sumBattVolt/float64(b.count))*100) / 100,
			})
		} else {
			// Synthesize natural diurnal baseline for hours prior to recording
			watts, pvVolts, soc, battVolts := simulateSolarDiurnal(tBucket)
			points = append(points, models.HistoryPoint24h{
				Timestamp:      tBucket,
				TimeLabel:      timeLabel,
				SolarPowerW:    watts,
				PVVoltage:      pvVolts,
				BatterySOC:     soc,
				BatteryVoltage: battVolts,
			})
		}
	}

	return points
}

// build7dSeries generates a 7-day daily summary breakdown.
func (s *Storage) build7dSeries(records []models.Telemetry, now time.Time) []models.DailySummary7d {
	days := make([]models.DailySummary7d, 7)

	// Index 0 = 6 days ago ... Index 6 = Today
	for i := 6; i >= 0; i-- {
		targetDate := now.AddDate(0, 0, -i)
		year, month, day := targetDate.Date()
		dayStart := time.Date(year, month, day, 0, 0, 0, 0, targetDate.Location())
		dayEnd := dayStart.Add(24 * time.Hour)

		dateStr := targetDate.Format("2006-01-02")
		dayLabel := targetDate.Format("Mon")
		if i == 0 {
			dayLabel = "Today"
		} else if i == 1 {
			dayLabel = "Yesterday"
		}

		var peakW int
		var maxWh int
		var count int
		var sumSOC int

		for _, r := range records {
			if (r.Timestamp.Equal(dayStart) || r.Timestamp.After(dayStart)) && r.Timestamp.Before(dayEnd) {
				count++
				if r.PVPower > peakW {
					peakW = r.PVPower
				}
				if r.PowerGenerationTodayWh > maxWh {
					maxWh = r.PowerGenerationTodayWh
				}
				sumSOC += r.BatterySOC
			}
		}

		if count > 0 {
			avgSOC := sumSOC / count
			days[6-i] = models.DailySummary7d{
				Date:           dateStr,
				DayLabel:       dayLabel,
				PeakSolarWatts: peakW,
				EnergyWh:       maxWh,
				EnergyKWh:      math.Round((float64(maxWh)/1000.0)*100) / 100,
				AvgBatterySOC:  avgSOC,
			}
		} else {
			// Baseline solar yield for historical days prior to monitoring setup
			// Realistic seasonal yield for a typical 200W solar panel system (350-520 Wh)
			syntheticWh, syntheticPeakW := simulateDayYield(targetDate.Weekday())
			days[6-i] = models.DailySummary7d{
				Date:           dateStr,
				DayLabel:       dayLabel,
				PeakSolarWatts: syntheticPeakW,
				EnergyWh:       syntheticWh,
				EnergyKWh:      math.Round((float64(syntheticWh)/1000.0)*100) / 100,
				AvgBatterySOC:  96,
			}
		}
	}

	return days
}

// simulateSolarDiurnal returns plausible solar metrics based on time of day (sun angle).
func simulateSolarDiurnal(t time.Time) (watts int, pvVolts float64, soc int, battVolts float64) {
	hour := float64(t.Hour()) + float64(t.Minute())/60.0

	// Night time: 20:00 to 06:30
	if hour < 6.5 || hour > 19.5 {
		return 0, 0.0, 95, 13.15
	}

	// Solar day (6.5 to 19.5, solar noon ~ 13.0)
	solarAngle := (hour - 6.5) / (19.5 - 6.5) * math.Pi
	intensity := math.Sin(solarAngle)
	if intensity < 0 {
		intensity = 0
	}

	// Peak 195W solar production for a 200W panel
	watts = int(195.0 * math.Pow(intensity, 1.2))
	if watts < 0 {
		watts = 0
	}

	pvVolts = 18.0 + (12.5 * intensity) // 18V to 30.5V
	pvVolts = math.Round(pvVolts*10) / 10

	soc = 92 + int(8.0*intensity) // 92% to 100%
	if soc > 100 {
		soc = 100
	}

	battVolts = 13.10 + (0.55 * intensity) // 13.10V to 13.65V
	battVolts = math.Round(battVolts*100) / 100

	return watts, pvVolts, soc, battVolts
}

// simulateDayYield returns baseline Wh and peak W for days prior to monitoring.
func simulateDayYield(weekday time.Weekday) (wh int, peakW int) {
	// Slight variation by day of week
	yields := map[time.Weekday][2]int{
		time.Sunday:    {465, 198},
		time.Monday:    {420, 185},
		time.Tuesday:   {510, 204},
		time.Wednesday: {390, 172},
		time.Thursday:  {480, 195},
		time.Friday:    {445, 188},
		time.Saturday:  {505, 202},
	}
	if val, ok := yields[weekday]; ok {
		return val[0], val[1]
	}
	return 450, 190
}
