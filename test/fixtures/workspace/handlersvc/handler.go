package handlersvc

import (
	"context"

	"example.com/pb"
)

type EchoHandler struct{}

var _ pb.EchoServiceServer = (*EchoHandler)(nil)

func (h *EchoHandler) Echo(ctx context.Context, req *pb.EchoRequest) (*pb.EchoResponse, error) {
	return &pb.EchoResponse{}, nil
}
