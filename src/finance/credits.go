package finance

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

const (
	// DefaultAlertDays is the runway below which a vendor is flagged when its
	// account doesn't say otherwise.
	DefaultAlertDays = 30
	// runwayRateDays is how many full days (yesterday back) the daily rate
	// averages.
	runwayRateDays = 7
	// creditSeriesDays is how far back the balance chart reaches.
	creditSeriesDays = 90

	auditCreditEntity = "credit_account"
	auditCreditAction = "credit_account.update"
)

// TopUpView is one credit purchase.
type TopUpView struct {
	Date         string `json:"date"`
	AmountMicros int64  `json:"amountMicros"`
	ReceiptID    string `json:"receiptId"`
}

// CreditVendor is one AI vendor's credit position. Balance, rate and runway
// are nil until an opening balance is entered; rate and runway are also nil
// without usage in the last seven full days.
type CreditVendor struct {
	VendorID             string     `json:"vendorId"`
	Name                 string     `json:"name"`
	Configured           bool       `json:"configured"`
	OpeningBalanceMicros *int64     `json:"openingBalanceMicros"`
	OpeningDate          *string    `json:"openingDate"`
	AlertDays            int        `json:"alertDays"`
	BalanceMicros        *int64     `json:"balanceMicros"`
	DailyRateMicros      *int64     `json:"dailyRateMicros"`
	RunwayDays           *int       `json:"runwayDays"`
	RunOutDate           *string    `json:"runOutDate"`
	BelowAlert           bool       `json:"belowAlert"`
	LastTopUp            *TopUpView `json:"lastTopUp"`
}

// CreditAlert is one vendor under its alert, for the banner.
type CreditAlert struct {
	VendorID   string `json:"vendorId"`
	Name       string `json:"name"`
	RunwayDays int    `json:"runwayDays"`
	RunOutDate string `json:"runOutDate"`
	AlertDays  int    `json:"alertDays"`
	Message    string `json:"message"`
}

// Projection is the dashed line from today's balance down to zero at the
// daily rate.
type Projection struct {
	From         string `json:"from"`
	StartMicros  int64  `json:"startMicros"`
	RateMicros   int64  `json:"rateMicros"`
	RunOutDate   string `json:"runOutDate"`
	RunwayDays   int    `json:"runwayDays"`
	AlreadyEmpty bool   `json:"alreadyEmpty"`
}

// SeriesVendor is one vendor's line on the balance chart. Balances has one
// entry per series day; nil before the opening date.
type SeriesVendor struct {
	VendorID   string      `json:"vendorId"`
	Name       string      `json:"name"`
	Balances   []*int64    `json:"balances"`
	TopUps     []TopUpView `json:"topUps"`
	Projection *Projection `json:"projection"`
}

// CreditSeries is the balance chart: days from From to Today.
type CreditSeries struct {
	From    string         `json:"from"`
	Today   string         `json:"today"`
	Days    []string       `json:"days"`
	Vendors []SeriesVendor `json:"vendors"`
}

// Credits is the AI credits tab.
type Credits struct {
	Today   string         `json:"today"`
	Vendors []CreditVendor `json:"vendors"`
	Alerts  []CreditAlert  `json:"alerts"`
	Series  CreditSeries   `json:"series"`
}

// Credits builds the AI credits tab: each AI vendor's balance (opening
// balance + top-ups − AI expense since the opening date), runway at the last
// seven full days' rate, the alerts and the balance chart.
//
// The expense is the token-pipeline estimate, replaced by the vendor's charge
// for reconciled months: their reconciliation entry adds charged − estimate.
// A reconciliation entry only counts for months that start on or after the
// opening date, since it adjusts the whole month.
func (s *Service) Credits(ctx context.Context) (Credits, error) {
	today := dateOnly(s.now())
	out := Credits{Today: today.Format(time.DateOnly), Vendors: []CreditVendor{}, Alerts: []CreditAlert{}}
	vendors, err := s.aiVendors(ctx)
	if err != nil {
		return out, err
	}
	accounts, err := s.creditAccounts(ctx)
	if err != nil {
		return out, err
	}

	seriesFrom := today.AddDate(0, 0, -creditSeriesDays)
	out.Series = CreditSeries{From: seriesFrom.Format(time.DateOnly), Today: out.Today, Days: []string{}, Vendors: []SeriesVendor{}}
	for d := seriesFrom; !d.After(today); d = d.AddDate(0, 0, 1) {
		out.Series.Days = append(out.Series.Days, d.Format(time.DateOnly))
	}

	for _, v := range vendors {
		acct := accounts[v.ID]
		cv, sv, err := s.creditVendor(ctx, v, acct, today, seriesFrom)
		if err != nil {
			return out, err
		}
		out.Vendors = append(out.Vendors, cv)
		out.Series.Vendors = append(out.Series.Vendors, sv)
		if cv.BelowAlert && cv.RunwayDays != nil && cv.RunOutDate != nil {
			out.Alerts = append(out.Alerts, CreditAlert{
				VendorID: v.ID, Name: v.Name, RunwayDays: *cv.RunwayDays, RunOutDate: *cv.RunOutDate, AlertDays: cv.AlertDays,
				Message: alertMessage(v.Name, *cv.RunwayDays, *cv.RunOutDate, cv.AlertDays),
			})
		}
	}
	slices.SortStableFunc(out.Alerts, func(a, b CreditAlert) int { return cmp.Compare(a.RunOutDate, b.RunOutDate) })
	return out, nil
}

func (s *Service) creditVendor(ctx context.Context, v fin.Vendor, acct fin.CreditAccount, today, seriesFrom time.Time) (CreditVendor, SeriesVendor, error) {
	cv := CreditVendor{VendorID: v.ID, Name: v.Name, AlertDays: acct.AlertDays}
	sv := SeriesVendor{VendorID: v.ID, Name: v.Name, TopUps: []TopUpView{}}

	last, err := s.repo.LastTopUp(ctx, v.ID)
	if err != nil {
		return cv, sv, err
	}
	if last != nil {
		cv.LastTopUp = &TopUpView{Date: last.Day.Format(time.DateOnly), AmountMicros: last.USDMicros, ReceiptID: last.ReceiptID}
	}
	topUps, err := s.repo.TopUps(ctx, v.ID, seriesFrom, today)
	if err != nil {
		return cv, sv, err
	}
	for _, t := range topUps {
		sv.TopUps = append(sv.TopUps, TopUpView{Date: t.Day.Format(time.DateOnly), AmountMicros: t.USDMicros, ReceiptID: t.ReceiptID})
	}

	n := int(today.Sub(seriesFrom).Hours()/24) + 1
	sv.Balances = make([]*int64, n)
	if acct.OpeningBalanceMicros == nil || acct.OpeningDate == nil {
		return cv, sv, nil
	}
	opening, openDate := *acct.OpeningBalanceMicros, dateOnly(*acct.OpeningDate)
	cv.Configured = true
	cv.OpeningBalanceMicros = new(opening)
	cv.OpeningDate = new(openDate.Format(time.DateOnly))

	flows, err := s.repo.CreditFlows(ctx, v.ID, openDate, today)
	if err != nil {
		return cv, sv, err
	}
	// Daily balances from the opening date; the series shows its window.
	balance := opening
	fi := 0
	for d := openDate; !d.After(today); d = d.AddDate(0, 0, 1) {
		for fi < len(flows) && !dateOnly(flows[fi].Day).After(d) {
			balance += creditDelta(flows[fi], openDate)
			fi++
		}
		if !d.Before(seriesFrom) {
			sv.Balances[int(d.Sub(seriesFrom).Hours()/24)] = new(balance)
		}
	}
	cv.BalanceMicros = new(balance)

	rate, err := s.dailyRate(ctx, v.ID, today)
	if err != nil {
		return cv, sv, err
	}
	if rate > 0 {
		runway := Runway(balance, rate)
		runOut := today.AddDate(0, 0, runway).Format(time.DateOnly)
		cv.DailyRateMicros = new(rate)
		cv.RunwayDays = new(runway)
		cv.RunOutDate = new(runOut)
		cv.BelowAlert = runway < acct.AlertDays
		sv.Projection = &Projection{
			From: today.Format(time.DateOnly), StartMicros: balance, RateMicros: rate,
			RunOutDate: runOut, RunwayDays: runway, AlreadyEmpty: balance <= 0,
		}
	} else if balance <= 0 {
		cv.BelowAlert = true
	}
	return cv, sv, nil
}

// creditDelta is one day's change to the balance. A reconciliation entry
// adjusts its whole month, so it only counts when that month starts on or
// after the opening date.
func creditDelta(f fin.DayFlow, openDate time.Time) int64 {
	d := f.TopUpMicros - f.EstimateMicros
	if f.ReconciliationMicros != 0 && !firstOfMonth(f.Day).Before(openDate) {
		d -= f.ReconciliationMicros
	}
	return d
}

// dailyRate is the average estimated AI cost per day over the last seven full
// days (yesterday back), in micros.
func (s *Service) dailyRate(ctx context.Context, vendorID string, today time.Time) (int64, error) {
	flows, err := s.repo.CreditFlows(ctx, vendorID, today.AddDate(0, 0, -runwayRateDays), today.AddDate(0, 0, -1))
	if err != nil {
		return 0, err
	}
	var sum int64
	for _, f := range flows {
		sum += f.EstimateMicros
	}
	return sum / runwayRateDays, nil
}

// Runway is how many whole days the balance lasts at rate micros a day; 0 when
// the balance is gone. rate must be positive.
func Runway(balance, rate int64) int {
	if balance <= 0 {
		return 0
	}
	return int(balance / rate)
}

func alertMessage(name string, runway int, runOut string, alertDays int) string {
	when := "today"
	if t, err := time.Parse(time.DateOnly, runOut); err == nil && runway > 0 {
		when = "in about " + plural(runway, "day", "days") + " (" + t.Format("Jan 2") + ")"
	}
	return fmt.Sprintf("%s credits run out %s, under your %d-day alert. Top up and forward the receipt to the inbox.", name, when, alertDays)
}

func (s *Service) aiVendors(ctx context.Context) ([]fin.Vendor, error) {
	all, err := s.repo.ListVendors(ctx)
	if err != nil {
		return nil, err
	}
	out := slices.DeleteFunc(all, func(v fin.Vendor) bool { return !v.IsAIPipeline })
	slices.SortFunc(out, func(a, b fin.Vendor) int { return cmp.Compare(a.Name, b.Name) })
	return out, nil
}

// creditAccounts returns every AI vendor's account, defaulted when missing.
func (s *Service) creditAccounts(ctx context.Context) (map[string]fin.CreditAccount, error) {
	rows, err := s.repo.ListCreditAccounts(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]fin.CreditAccount{}
	for _, a := range rows {
		out[a.VendorID] = a
	}
	vendors, err := s.aiVendors(ctx)
	if err != nil {
		return nil, err
	}
	for _, v := range vendors {
		if _, ok := out[v.ID]; !ok {
			out[v.ID] = fin.CreditAccount{VendorID: v.ID, AlertDays: DefaultAlertDays}
		}
	}
	return out, nil
}

// CreditAccountEdit changes an account. A nil field keeps its value; the
// opening balance and date are set together.
type CreditAccountEdit struct {
	OpeningBalanceMicros *int64  `json:"openingBalanceMicros"`
	OpeningDate          *string `json:"openingDate"`
	AlertDays            *int    `json:"alertDays"`
}

// SetCreditAccount saves an AI vendor's opening balance, opening date and
// alert days, audited.
func (s *Service) SetCreditAccount(ctx context.Context, actor, vendorID string, ed CreditAccountEdit) (CreditVendor, error) {
	v, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		return CreditVendor{}, err
	}
	if !v.IsAIPipeline {
		return CreditVendor{}, &ErrInvalid{Msg: v.Name + " is not paid with prepaid AI credit"}
	}
	if (ed.OpeningBalanceMicros == nil) != (ed.OpeningDate == nil) {
		return CreditVendor{}, &ErrInvalid{Msg: "set the opening balance and its date together"}
	}
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		before, err := tx.GetCreditAccount(ctx, vendorID)
		if errors.Is(err, fin.ErrNotFound) {
			before = &fin.CreditAccount{VendorID: vendorID, AlertDays: DefaultAlertDays}
		} else if err != nil {
			return err
		}
		next := *before
		next.UpdatedBy = actor
		if ed.AlertDays != nil {
			if *ed.AlertDays < 1 || *ed.AlertDays > 365 {
				return &ErrInvalid{Msg: "alert days must be between 1 and 365"}
			}
			next.AlertDays = *ed.AlertDays
		}
		if ed.OpeningDate != nil {
			d := parseDate(*ed.OpeningDate)
			if d == nil {
				return &ErrInvalid{Msg: "opening date is YYYY-MM-DD"}
			}
			if d.After(dateOnly(s.now())) {
				return &ErrInvalid{Msg: "the opening date can't be in the future"}
			}
			if *ed.OpeningBalanceMicros < 0 {
				return &ErrInvalid{Msg: "the opening balance can't be negative"}
			}
			next.OpeningDate = d
			next.OpeningBalanceMicros = new(*ed.OpeningBalanceMicros)
		}
		if err := tx.UpsertCreditAccount(ctx, &next); err != nil {
			return err
		}
		return tx.Audit(ctx, actor, auditCreditAction, auditCreditEntity, vendorID, accountAudit(before), accountAudit(&next), nil)
	})
	if err != nil {
		return CreditVendor{}, err
	}
	c, err := s.Credits(ctx)
	if err != nil {
		return CreditVendor{}, err
	}
	for _, cv := range c.Vendors {
		if cv.VendorID == vendorID {
			return cv, nil
		}
	}
	return CreditVendor{}, fin.ErrNotFound
}

func accountAudit(a *fin.CreditAccount) map[string]any {
	m := map[string]any{"alertDays": a.AlertDays}
	if a.OpeningBalanceMicros != nil && a.OpeningDate != nil {
		m["openingBalanceMicros"] = *a.OpeningBalanceMicros
		m["openingDate"] = a.OpeningDate.Format(time.DateOnly)
	}
	return m
}
