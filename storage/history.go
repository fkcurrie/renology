package storage

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"time"

	"renology/models"
)

// GetLatest reads and returns the latest telemetry snapshot.
func (s *Storage) GetLatest() (*models.Telemetry, error) {
	s.mu.RLock()
	cached := s.cachedLatest
	s.mu.RUnlock()

	if cached != nil {
		cpy := *cached
		return &cpy, nil
	}

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
	s.cachedLatest = &t
	return &t, nil
}

// GetHistory parses recorded telemetry and produces multi-timespan historical series (24h, 7d, 30d, 90d, 180d, 365d, 12m).
func (s *Storage) GetHistory(referenceTime time.Time) (*models.HistoryResponse, error) {
	if referenceTime.IsZero() {
		referenceTime = time.Now()
	}

	// 0. Fast-path: return cached history under RLock if fresh within 45 seconds
	s.mu.RLock()
	if s.cachedHistory != nil && referenceTime.Sub(s.cachedHistoryTime) < 45*time.Second && referenceTime.Sub(s.cachedHistoryTime) >= 0 {
		cached := s.cachedHistory
		s.mu.RUnlock()
		return cached, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()

	// Double check under write lock
	if s.cachedHistory != nil && referenceTime.Sub(s.cachedHistoryTime) < 45*time.Second && referenceTime.Sub(s.cachedHistoryTime) >= 0 {
		return s.cachedHistory, nil
	}

	var points24h []models.HistoryPoint24h
	var points7d []models.HistoryPoint24h
	var points30d []models.HistoryPoint24h
	var points90d []models.HistoryPoint24h
	var points180d []models.HistoryPoint24h
	var points365d []models.HistoryPoint24h
	dailyMap := make(map[string]models.DailySummaryRecord)

	if s.db != nil {
		// Fast SQLite indexed bucket queries — avoids scanning 100,000 raw rows!
		points24h = s.buildBucketedSeriesFromDB(referenceTime.Add(-24*time.Hour), referenceTime, 15*time.Minute, "15:04")
		points7d = s.buildBucketedSeriesFromDB(referenceTime.Add(-7*24*time.Hour), referenceTime, 15*time.Minute, "Mon 15:04")

		start365 := referenceTime.AddDate(-1, 0, -2)
		endNow := referenceTime.Add(24 * time.Hour)
		if m, err := s.queryDailyAggregates(start365, endNow); err == nil && len(m) > 0 {
			dailyMap = m
		}

		// Recompute 30d, 90d, 180d, 365d only if older than 10 minutes (or on cold start)
		if s.cachedHistory != nil && len(s.cachedHistory.Points30d) > 0 && referenceTime.Sub(s.cachedLongHistoryTime) < 10*time.Minute {
			points30d = s.cachedHistory.Points30d
			points90d = s.cachedHistory.Points90d
			points180d = s.cachedHistory.Points180d
			points365d = s.cachedHistory.Points365d
		} else {
			start30d := referenceTime.Add(-30 * 24 * time.Hour)
			points30d = s.buildBucketedSeriesFromDB(start30d, referenceTime, 3*time.Hour, "Jan 02 15:04")

			start90d := referenceTime.Add(-90 * 24 * time.Hour)
			points90d = s.buildBucketedSeriesFromDB(start90d, referenceTime, 6*time.Hour, "Jan 02 15:04")

			start180d := referenceTime.Add(-180 * 24 * time.Hour)
			points180d = s.buildBucketedSeriesFromDB(start180d, referenceTime, 12*time.Hour, "Jan 02 15:04")

			start365d := referenceTime.Add(-365 * 24 * time.Hour)
			points365d = s.buildBucketedSeriesFromDB(start365d, referenceTime, 24*time.Hour, "Jan 02")

			s.cachedLongHistoryTime = referenceTime
		}
	} else {
		// Fallback to JSONL file if database was empty or not ready
		records := s.readAllTelemetryRecords()
		points24h = s.build24hSeries(records, referenceTime)
		points7d = s.build7dSeriesPoints(records, referenceTime)

		start30d := referenceTime.Add(-30 * 24 * time.Hour)
		points30d = buildTimeSeries(records, start30d, referenceTime, 3*time.Hour, "Jan 02 15:04")

		start90d := referenceTime.Add(-90 * 24 * time.Hour)
		points90d = buildTimeSeries(records, start90d, referenceTime, 6*time.Hour, "Jan 02 15:04")

		start180d := referenceTime.Add(-180 * 24 * time.Hour)
		points180d = buildTimeSeries(records, start180d, referenceTime, 12*time.Hour, "Jan 02 15:04")

		start365d := referenceTime.Add(-365 * 24 * time.Hour)
		points365d = buildTimeSeries(records, start365d, referenceTime, 24*time.Hour, "Jan 02")

		for _, r := range records {
			dStr := r.Timestamp.Format("2006-01-02")
			existing, ok := dailyMap[dStr]
			if !ok {
				existing = models.DailySummaryRecord{
					Date: dStr,
				}
			}
			if r.PVPower > existing.PeakSolarWatts {
				existing.PeakSolarWatts = r.PVPower
			}
			if r.PowerGenerationTodayWh > existing.EnergyWh {
				existing.EnergyWh = r.PowerGenerationTodayWh
				existing.EnergyKWh = math.Round((float64(existing.EnergyWh)/1000.0)*100) / 100
			}
			if r.PVVoltage > existing.MaxPVVoltage {
				existing.MaxPVVoltage = r.PVVoltage
			}
			existing.AvgBatterySOC = r.BatterySOC
			dailyMap[dStr] = existing
		}
	}

	// 5. Build Multi-Timespan Daily Summaries (for Card 5 & backwards-compat)
	days7dRecords := s.buildNDaySeries(dailyMap, referenceTime, 7)
	days30d := s.buildNDaySeries(dailyMap, referenceTime, 30)
	days90d := s.buildNDaySeries(dailyMap, referenceTime, 90)
	days180d := s.buildNDaySeries(dailyMap, referenceTime, 180)
	days365d := s.buildNDaySeries(dailyMap, referenceTime, 365)
	months12m := s.build12MonthsSeries(days365d, referenceTime)

	// Convert 7d to legacy models.DailySummary7d
	days7d := make([]models.DailySummary7d, len(days7dRecords))
	for i, r := range days7dRecords {
		days7d[i] = models.DailySummary7d{
			Date:           r.Date,
			DayLabel:       r.DayLabel,
			PeakSolarWatts: r.PeakSolarWatts,
			EnergyWh:       r.EnergyWh,
			EnergyKWh:      r.EnergyKWh,
			AvgBatterySOC:  r.AvgBatterySOC,
			MaxPVVoltage:   r.MaxPVVoltage,
		}
	}

	var peaks *models.PeriodPeaks
	if s.db != nil {
		loc := referenceTime.Location()
		startToday := time.Date(referenceTime.Year(), referenceTime.Month(), referenceTime.Day(), 0, 0, 0, 0, loc)
		pToday := s.queryPeakRecord(startToday, referenceTime, referenceTime)
		pWeek := s.queryPeakRecord(referenceTime.Add(-7*24*time.Hour), referenceTime, referenceTime)
		pMonth := s.queryPeakRecord(referenceTime.Add(-30*24*time.Hour), referenceTime, referenceTime)
		pQuarter := s.queryPeakRecord(referenceTime.Add(-90*24*time.Hour), referenceTime, referenceTime)
		pHalfYear := s.queryPeakRecord(referenceTime.Add(-180*24*time.Hour), referenceTime, referenceTime)
		pYear := s.queryPeakRecord(referenceTime.Add(-365*24*time.Hour), referenceTime, referenceTime)

		alignPeak := func(broader, narrower *models.PeakRecord) {
			if broader.Voltage < narrower.Voltage {
				broader.Voltage = narrower.Voltage
				broader.VoltageTime = narrower.VoltageTime
				broader.VoltageTimeStr = narrower.VoltageTimeStr
			}
			if broader.SolarPowerW < narrower.SolarPowerW {
				broader.SolarPowerW = narrower.SolarPowerW
				broader.SolarPowerTime = narrower.SolarPowerTime
				broader.SolarPowerTimeStr = narrower.SolarPowerTimeStr
			}
		}

		alignPeak(&pWeek, &pToday)
		alignPeak(&pMonth, &pWeek)
		alignPeak(&pQuarter, &pMonth)
		alignPeak(&pHalfYear, &pQuarter)
		alignPeak(&pYear, &pHalfYear)

		peaks = &models.PeriodPeaks{
			Today:    pToday,
			Week:     pWeek,
			Month:    pMonth,
			Quarter:  pQuarter,
			HalfYear: pHalfYear,
			Year:     pYear,
		}
	}

	resp := &models.HistoryResponse{
		Points24h:  points24h,
		Points7d:   points7d,
		Points30d:  points30d,
		Points90d:  points90d,
		Points180d: points180d,
		Points365d: points365d,
		Days7d:     days7d,
		Days30d:    days30d,
		Days90d:    days90d,
		Days180d:   days180d,
		Days365d:   days365d,
		Months12m:  months12m,
		SunTimes:   GetDorsetSunTimes(referenceTime),
		Peaks:      peaks,
	}

	s.cachedHistory = resp
	s.cachedHistoryTime = referenceTime
	return resp, nil
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

// buildTimeSeries generates a downsampled history curve for a given duration and bucket interval from telemetry records.
func buildTimeSeries(records []models.Telemetry, startWindow time.Time, now time.Time, bucketDuration time.Duration, timeFormat string) []models.HistoryPoint24h {
	if bucketDuration <= 0 {
		return nil
	}
	numBuckets := int(now.Sub(startWindow) / bucketDuration)
	if numBuckets <= 0 {
		return nil
	}
	if numBuckets > 2000 {
		numBuckets = 2000
	}

	points := make([]models.HistoryPoint24h, 0, numBuckets)

	type bucketData struct {
		count        int
		sumWatts     int
		maxWatts     int
		sumBattWatts float64
		maxBattWatts float64
		sumVolts     float64
		maxVolts     float64
		sumSOC       int
		sumBattVolt  float64
	}

	buckets := make([]bucketData, numBuckets)

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

		b := &buckets[idx]
		b.count++
		b.sumWatts += r.PVPower
		if r.PVPower > b.maxWatts {
			b.maxWatts = r.PVPower
		}
		battWatts := r.BatteryPower
		if battWatts == 0 && r.BatteryCurrent > 0 {
			battWatts = r.BatteryVoltage * r.BatteryCurrent
		}
		b.sumBattWatts += battWatts
		if battWatts > b.maxBattWatts {
			b.maxBattWatts = battWatts
		}
		b.sumVolts += r.PVVoltage
		if r.PVVoltage > b.maxVolts {
			b.maxVolts = r.PVVoltage
		}
		b.sumSOC += r.BatterySOC
		b.sumBattVolt += r.BatteryVoltage
	}

	for i := 0; i < numBuckets; i++ {
		tBucket := startWindow.Add(time.Duration(i) * bucketDuration)
		timeLabel := tBucket.Format(timeFormat)
		b := buckets[i]

		if b.count > 0 {
			points = append(points, models.HistoryPoint24h{
				Timestamp:      tBucket,
				TimeLabel:      timeLabel,
				SolarPowerW:    b.maxWatts,
				BatteryPowerW:  int(math.Round(b.maxBattWatts)),
				PVVoltage:      math.Round(b.maxVolts*10) / 10,
				BatterySOC:     b.sumSOC / b.count,
				BatteryVoltage: math.Round((b.sumBattVolt/float64(b.count))*100) / 100,
			})
		} else {
			// Real telemetry only: if unrecorded, values are 0
			points = append(points, models.HistoryPoint24h{
				Timestamp:      tBucket,
				TimeLabel:      timeLabel,
				SolarPowerW:    0,
				BatteryPowerW:  0,
				PVVoltage:      0,
				BatterySOC:     0,
				BatteryVoltage: 0,
			})
		}
	}

	return points
}

// build24hSeries generates a 24-hour history curve in 15-minute intervals (96 points).
func (s *Storage) build24hSeries(records []models.Telemetry, now time.Time) []models.HistoryPoint24h {
	startWindow := now.Add(-24 * time.Hour)
	return buildTimeSeries(records, startWindow, now, 15*time.Minute, "15:04")
}

// build7dSeriesPoints generates a 7-day history curve in 15-minute intervals (672 points).
func (s *Storage) build7dSeriesPoints(records []models.Telemetry, now time.Time) []models.HistoryPoint24h {
	startWindow := now.Add(-7 * 24 * time.Hour)
	return buildTimeSeries(records, startWindow, now, 15*time.Minute, "Mon 15:04")
}

// buildBucketedSeriesFromDB queries SQLite for time-series bucket averages and aligns into contiguous buckets.
func (s *Storage) buildBucketedSeriesFromDB(startWindow, now time.Time, bucketDuration time.Duration, timeFormat string) []models.HistoryPoint24h {
	bucketSec := int64(bucketDuration.Seconds())
	if bucketSec <= 0 {
		return nil
	}
	numBuckets := int(now.Sub(startWindow) / bucketDuration)
	if numBuckets <= 0 {
		return nil
	}
	if numBuckets > 2000 {
		numBuckets = 2000
	}

	bucketMap, err := s.queryTelemetryBuckets(startWindow, now, int(bucketSec))
	if err != nil {
		bucketMap = make(map[int64]models.HistoryPoint24h)
	}

	endEpoch := (now.Unix() / bucketSec) * bucketSec
	points := make([]models.HistoryPoint24h, numBuckets)
	for i := 0; i < numBuckets; i++ {
		bEpoch := endEpoch - int64(numBuckets-1-i)*bucketSec
		tBucket := time.Unix(bEpoch, 0).In(now.Location())
		timeLabel := tBucket.Format(timeFormat)

		if p, ok := bucketMap[bEpoch]; ok {
			p.TimeLabel = timeLabel
			p.Timestamp = tBucket
			points[i] = p
		} else {
			points[i] = models.HistoryPoint24h{
				Timestamp:      tBucket,
				TimeLabel:      timeLabel,
				SolarPowerW:    0,
				BatteryPowerW:  0,
				PVVoltage:      0,
				BatterySOC:     0,
				BatteryVoltage: 0,
			}
		}
	}
	return points
}

// buildNDaySeries generates an N-day daily summary breakdown (7, 30, 90, 180, 365 days).
func (s *Storage) buildNDaySeries(dailyMap map[string]models.DailySummaryRecord, now time.Time, nDays int) []models.DailySummaryRecord {
	days := make([]models.DailySummaryRecord, nDays)

	for i := nDays - 1; i >= 0; i-- {
		targetDate := now.AddDate(0, 0, -i)
		dateStr := targetDate.Format("2006-01-02")

		dayLabel := targetDate.Format("Mon")
		if nDays > 14 {
			dayLabel = targetDate.Format("Jan 02")
		}
		if i == 0 {
			dayLabel = "Today"
		} else if i == 1 && nDays <= 14 {
			dayLabel = "Yesterday"
		}

		if record, ok := dailyMap[dateStr]; ok {
			record.DayLabel = dayLabel
			days[nDays-1-i] = record
		} else {
			// Real telemetry only: prior to monitoring installation, values are 0
			days[nDays-1-i] = models.DailySummaryRecord{
				Date:           dateStr,
				DayLabel:       dayLabel,
				PeakSolarWatts: 0,
				EnergyWh:       0,
				EnergyKWh:      0,
				AvgBatterySOC:  0,
				MaxPVVoltage:   0,
			}
		}
	}

	return days
}

// build12MonthsSeries aggregates the 365 daily records into 12 monthly totals.
func (s *Storage) build12MonthsSeries(daily365 []models.DailySummaryRecord, now time.Time) []models.MonthlySummaryRecord {
	monthsMap := make(map[string]*models.MonthlySummaryRecord)
	monthKeys := make([]string, 0, 12)

	// Past 12 months order: from 11 months ago to current month
	for i := 11; i >= 0; i-- {
		mDate := now.AddDate(0, -i, 0)
		key := mDate.Format("2006-01")
		label := mDate.Format("Jan 2006")
		rec := &models.MonthlySummaryRecord{
			MonthKey:   key,
			MonthLabel: label,
		}
		monthsMap[key] = rec
		monthKeys = append(monthKeys, key)
	}

	for _, d := range daily365 {
		if len(d.Date) >= 7 {
			mKey := d.Date[:7]
			if mRec, ok := monthsMap[mKey]; ok {
				mRec.TotalEnergyWh += d.EnergyWh
				mRec.DaysCounted++
				if d.PeakSolarWatts > mRec.PeakWatts {
					mRec.PeakWatts = d.PeakSolarWatts
				}
			}
		}
	}

	result := make([]models.MonthlySummaryRecord, 0, 12)
	for _, key := range monthKeys {
		rec := monthsMap[key]
		rec.TotalEnergyKWh = math.Round((float64(rec.TotalEnergyWh)/1000.0)*10) / 10
		if rec.DaysCounted > 0 {
			rec.DailyAvgWh = rec.TotalEnergyWh / rec.DaysCounted
		}
		result = append(result, *rec)
	}
	return result
}

// build7dSeries generates a 7-day daily summary breakdown (legacy compatibility).
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
			// Real telemetry only: if unrecorded, values are 0
			days[6-i] = models.DailySummary7d{
				Date:           dateStr,
				DayLabel:       dayLabel,
				PeakSolarWatts: 0,
				EnergyWh:       0,
				EnergyKWh:      0,
				AvgBatterySOC:  0,
			}
		}
	}

	return days
}


// GetRecentTelemetry retrieves recent telemetry records and computes a minute-by-minute downsampled summary.
func (s *Storage) GetRecentTelemetry(minutes int, referenceTime time.Time) (*models.RecentHistoryResponse, []models.Telemetry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if minutes <= 0 {
		minutes = 60
	}
	if minutes > 1440 {
		minutes = 1440
	}
	if referenceTime.IsZero() {
		referenceTime = time.Now()
	}

	startWindow := referenceTime.Add(-time.Duration(minutes) * time.Minute)
	endWindow := referenceTime.Add(1 * time.Minute)

	var records []models.Telemetry
	if s.db != nil {
		if sqlRecords, err := s.queryTelemetryRange(startWindow, endWindow); err == nil && len(sqlRecords) > 0 {
			records = sqlRecords
		}
	}

	if len(records) == 0 {
		all := s.readAllTelemetryRecords()
		for _, r := range all {
			if !r.Timestamp.Before(startWindow) && !r.Timestamp.After(endWindow) {
				records = append(records, r)
			}
		}
	}

	resp := &models.RecentHistoryResponse{
		WindowMinutes: minutes,
		StartTime:     startWindow,
		EndTime:       referenceTime,
		TotalSamples:  len(records),
		MinutePoints:  make([]models.RecentMinutePoint, 0),
	}

	if len(records) == 0 {
		resp.StatusSummary = "No telemetry samples recorded in the specified time window."
		return resp, nil, nil
	}

	// Calculate overall statistics and group by minute
	type minuteBucket struct {
		ts      time.Time
		pvVolts []float64
		pvWatts []int
		battSoc []int
		battV   []float64
		battA   []float64
		todayWh int
		status  string
	}

	minuteMap := make(map[string]*minuteBucket)
	var orderedKeys []string

	var sumBattV float64
	var sumPVV float64
	var sumWatts float64
	minPV := 999.0
	maxPV := 0.0
	peakW := 0
	lastSOC := 0
	lastWh := 0

	for _, r := range records {
		sumBattV += r.BatteryVoltage
		sumPVV += r.PVVoltage
		sumWatts += float64(r.PVPower)
		if r.PVVoltage < minPV {
			minPV = r.PVVoltage
		}
		if r.PVVoltage > maxPV {
			maxPV = r.PVVoltage
		}
		if r.PVPower > peakW {
			peakW = r.PVPower
		}
		lastSOC = r.BatterySOC
		if r.PowerGenerationTodayWh > lastWh {
			lastWh = r.PowerGenerationTodayWh
		}

		key := r.Timestamp.Local().Format("15:04")
		bucket, exists := minuteMap[key]
		if !exists {
			bucket = &minuteBucket{
				ts: r.Timestamp.Local(),
			}
			minuteMap[key] = bucket
			orderedKeys = append(orderedKeys, key)
		}
		bucket.pvVolts = append(bucket.pvVolts, r.PVVoltage)
		bucket.pvWatts = append(bucket.pvWatts, r.PVPower)
		bucket.battSoc = append(bucket.battSoc, r.BatterySOC)
		bucket.battV = append(bucket.battV, r.BatteryVoltage)
		bucket.battA = append(bucket.battA, r.BatteryCurrent)
		if r.PowerGenerationTodayWh > bucket.todayWh {
			bucket.todayWh = r.PowerGenerationTodayWh
		}
		bucket.status = r.ChargingStatus
	}

	n := float64(len(records))
	resp.BatterySOC = lastSOC
	resp.AvgBatteryV = math.Round((sumBattV/n)*100) / 100
	resp.AvgPVVoltage = math.Round((sumPVV/n)*10) / 10
	resp.MinPVVoltage = math.Round(minPV*10) / 10
	resp.MaxPVVoltage = math.Round(maxPV*10) / 10
	resp.AvgSolarWatts = math.Round((sumWatts/n)*10) / 10
	resp.PeakSolarWatts = peakW
	resp.TodayYieldWh = lastWh

	// Build minute points
	for _, k := range orderedKeys {
		b := minuteMap[k]
		var avgPV, avgW, avgV, avgA float64
		var avgSOC int
		peakMinuteW := 0

		for _, v := range b.pvVolts {
			avgPV += v
		}
		avgPV /= float64(len(b.pvVolts))

		for _, w := range b.pvWatts {
			avgW += float64(w)
			if w > peakMinuteW {
				peakMinuteW = w
			}
		}
		avgW /= float64(len(b.pvWatts))

		for _, s := range b.battSoc {
			avgSOC += s
		}
		avgSOC /= len(b.battSoc)

		for _, v := range b.battV {
			avgV += v
		}
		avgV /= float64(len(b.battV))

		for _, a := range b.battA {
			avgA += a
		}
		avgA /= float64(len(b.battA))

		mode := "Standby / Rest"
		if avgSOC >= 95 && avgPV >= 28 && avgW < 50 {
			mode = "Float / Standby"
		} else if avgW >= 50 {
			mode = "Active MPPT"
		} else if avgPV < 15 {
			mode = "Night / Resting"
		} else {
			mode = "Trickle / Standby"
		}

		resp.MinutePoints = append(resp.MinutePoints, models.RecentMinutePoint{
			Timestamp:      b.ts,
			TimeLabel:      k,
			PVVoltage:      math.Round(avgPV*10) / 10,
			SolarPowerW:    int(math.Round(avgW)),
			PeakSolarW:     peakMinuteW,
			BatterySOC:     avgSOC,
			BatteryVoltage: math.Round(avgV*100) / 100,
			BatteryCurrent: math.Round(avgA*100) / 100,
			TodayYieldWh:   b.todayWh,
			Mode:           mode,
		})
	}

	// High level status summary
	if resp.BatterySOC >= 95 && resp.AvgSolarWatts < 50 && resp.AvgPVVoltage >= 28 {
		resp.StatusSummary = "System is in Float / Smart Curtailment. Battery tank is full (100%), resting on solar standby under direct sunshine."
	} else if resp.AvgSolarWatts >= 50 {
		resp.StatusSummary = fmt.Sprintf("Actively harvesting solar power. Generating an average of %.1fW (Peak %dW).", resp.AvgSolarWatts, resp.PeakSolarWatts)
	} else if resp.AvgPVVoltage < 15 {
		resp.StatusSummary = "Low sun / nocturnal conditions. Panels are dormant and running on battery storage."
	} else {
		resp.StatusSummary = "Normal operations under diffuse daylight."
	}

	return resp, records, nil
}
