package ogenreceipts

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	receiptsv1 "github.com/ogen-app/harbor/gen/receipts/v1"
)

type fakeServer struct {
	receiptsv1.UnimplementedReceiptServiceServer
	gotAuth string
	last    *receiptsv1.ProcessReceiptRequest
}

func (s *fakeServer) ProcessReceipt(ctx context.Context, req *receiptsv1.ProcessReceiptRequest) (*receiptsv1.ProcessReceiptResponse, error) {
	if md, ok := metadata.FromIncomingContext(ctx); ok && len(md.Get("authorization")) > 0 {
		s.gotAuth = md.Get("authorization")[0]
	}
	s.last = req
	tax := int64(0)
	return &receiptsv1.ProcessReceiptResponse{
		RawMime: []byte("raw"),
		Headers: &receiptsv1.EmailHeaders{From: "ops@ogen.app", Subject: "Fwd: receipt", Date: timestamppb.New(time.Unix(1000, 0)), ForwardedFrom: "billing@zernio.com"},
		// A 5 MiB attachment: over gRPC's 4 MiB default, inside the service's 64 MiB.
		Attachments: []*receiptsv1.Attachment{{Filename: "big.pdf", Content: bytes.Repeat([]byte{1}, 5<<20)}},
		Extraction: &receiptsv1.Extraction{
			Kind: receiptsv1.ReceiptKind_RECEIPT_KIND_CREDIT_NOTE, MerchantName: "Zernio", DocumentNumber: "ZRN-1",
			TaxMicros: &tax, LineItems: []*receiptsv1.LineItem{{Description: "Growth"}},
		},
		Usage: &receiptsv1.ModelUsage{ModelId: "claude-haiku-5-5", CostMicros: 4200},
	}, nil
}

func TestProcessRoundTrip(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeServer{}
	gs := grpc.NewServer(grpc.MaxSendMsgSize(maxMessageBytes), grpc.MaxRecvMsgSize(maxMessageBytes))
	receiptsv1.RegisterReceiptServiceServer(gs, fake)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)

	c, err := New(lis.Addr().String(), "tok")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })

	res, err := c.ProcessByResendID(t.Context(), "re_1")
	if err != nil {
		t.Fatal(err)
	}
	if fake.gotAuth != "Bearer tok" || fake.last.GetResendEmailId() != "re_1" {
		t.Errorf("auth %q request %v", fake.gotAuth, fake.last)
	}
	x := res.Extraction
	if x.Kind != "credit_note" || x.TaxMicros == nil || *x.TaxMicros != 0 || x.SubtotalMicros != nil || x.LineItems[0].AmountMicros != nil {
		t.Errorf("extraction = %+v", x)
	}
	if res.Headers.Date == nil || res.Headers.ForwardedFrom != "billing@zernio.com" || len(res.Attachments[0].Content) != 5<<20 {
		t.Errorf("headers %+v, attachment %d bytes", res.Headers, len(res.Attachments[0].Content))
	}
	if res.Usage.CostMicros != 4200 {
		t.Errorf("usage = %+v", res.Usage)
	}

	if _, err := c.ProcessRawMIME(t.Context(), []byte("mime")); err != nil || string(fake.last.GetRawMime()) != "mime" {
		t.Errorf("raw: %v %v", err, fake.last)
	}

	var nilClient *Client
	if _, err := nilClient.ProcessByResendID(t.Context(), "x"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("nil client: %v", err)
	}
}
