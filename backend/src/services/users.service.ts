import HttpException from '../exceptions/HttpException';
import userModel from '../models/users.model';

class UserService {
  private users = userModel;

  public async findUserById(id: string): Promise<IUserDocument | null> {
    const user = await this.users.findById(id);

    return user;
  }

  public async findUserByAddress(address: string): Promise<IUserDocument | null> {
    const user = await this.users.findOne({ address });

    return user;
  }

  public async findAndUpdateNonce(
    address: string,
    nonce: string,
    expiredAt: Date,
  ): Promise<IUserDocument> {
    const user = await this.users.findOneAndUpdate(
      { address },
      {
        $set: {
          'authChallenge.nonce': nonce,
          'authChallenge.expiredAt': expiredAt,
          'authChallenge.used': false,
        },
      },
      { new: true, upsert: true },
    );

    return user;
  }

  public async markNonceAsUsed(address: string): Promise<IUserDocument | null> {
    const user = await this.users.findOneAndUpdate(
      { address },
      { $set: { 'authChallenge.used': true } },
      { new: true },
    );

    return user;
  }

  public async findUserNonce(
    address: string,
  ): Promise<{ nonce: string; expiredAt: Date; used: boolean } | null> {
    const user = await this.users
      .findOne({ address })
      .select('authChallenge.nonce authChallenge.expiredAt authChallenge.used');

    return user
      ? {
          nonce: user.authChallenge.nonce,
          expiredAt: user.authChallenge.expiredAt,
          used: user.authChallenge.used,
        }
      : null;
  }
}

export default UserService;
