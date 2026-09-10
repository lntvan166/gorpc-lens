package callersvc

import (
	"context"

	"example.com/pb"
)

type Biz struct {
	echoClient pb.EchoServiceClient
}

func (b *Biz) Run(ctx context.Context) error {
	_, err := b.echoClient.Echo(ctx, &pb.EchoRequest{})
	return err
}
