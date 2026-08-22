// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAnima} from "../interfaces/IAnima.sol";
import {IERC6551Account} from "../interfaces/IERC6551.sol";
import {BondVault} from "../registry/BondVault.sol";

interface IAnimaMarketHooks {
    function accountOf(uint256 agentId) external view returns (address);
    function brainRoot(uint256 agentId) external view returns (bytes32);
    function brainEpoch(uint256 agentId) external view returns (uint64);
    function locked(uint256 tokenId) external view returns (bool);
    function lockAgent(uint256 agentId) external;
    function unlockAgent(uint256 agentId) external;
    function moduleSetUser(uint256 tokenId, address user, uint64 expires) external;
}

/**
 * @title AgentMarket — buying an agent, not a picture of one
 * @notice An off-chain-order, on-chain-settlement marketplace for ANIMA agents, supporting
 *         outright sale and time-boxed rental.
 *
 * @dev What makes this different from listing an agent on a generic NFT marketplace:
 *
 *      An agent is not a static asset. Between the moment you decide to buy one and the
 *      moment your transaction lands, the seller can empty its wallet, wipe its memory, or
 *      pull its bond — and on a generic marketplace your fill would still succeed. You would
 *      receive a token whose entire value has been removed, and nothing about the trade
 *      would look irregular on-chain.
 *
 *      So every order here binds to the agent's *substance*, not just its id:
 *
 *        `expectedAccountState`  the ERC-6551 account nonce. ERC-6551 defines `state()`
 *                                precisely so buyers can detect a drain, and then leaves it
 *                                to integrators — who overwhelmingly ignore it. Here a fill
 *                                reverts if the account was touched after quoting.
 *        `expectedBrainRoot`     the commitment to the agent's private state. A seller who
 *                                strips the memory before delivery invalidates their own
 *                                order.
 *        `minBondCoverage`       free slashable collateral that must still be standing.
 *                                Buying a "bonded" agent whose bond is mid-withdrawal is
 *                                buying nothing.
 *
 *      Each check is opt-out (sentinel `type(uint256).max` / zero) so plain collectible
 *      trades stay cheap, but the defaults in the SDK turn them all on.
 *
 *      Royalties are honoured where ERC-2981 declares them. They are not enforced, because
 *      as of 2026 nothing enforces them without also making the asset untradeable on half
 *      the market — see the note on {AnimaAgent.setDefaultRoyalty}.
 */
contract AgentMarket is EIP712, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    enum OrderKind {
        Sale,
        Rental
    }

    struct Order {
        OrderKind kind;
        address maker; //                 seller or lessor; must own the agent at fill
        address taker; //                 zero for an open order
        uint256 agentId;
        address payToken; //              zero address means native currency
        uint256 price;
        uint64 start;
        uint64 expiry;
        uint64 duration; //               rental term in seconds; ignored for a sale
        uint256 nonce;
        uint256 expectedAccountState; //  type(uint256).max to skip
        bytes32 expectedBrainRoot; //     zero to skip
        uint64 expectedBrainEpoch; //     paired with the root; ignored when root is zero
        uint256 minBondCoverage; //       zero to skip
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    bytes32 private constant _ORDER_TYPEHASH = keccak256(
        "Order(uint8 kind,address maker,address taker,uint256 agentId,address payToken,uint256 price,uint64 start,uint64 expiry,uint64 duration,uint256 nonce,uint256 expectedAccountState,bytes32 expectedBrainRoot,uint64 expectedBrainEpoch,uint256 minBondCoverage)"
    );

    uint256 public constant SKIP_STATE_CHECK = type(uint256).max;
    uint16 public constant MAX_FEE_BPS = 500; // 5% ceiling governance cannot exceed

    IAnima public immutable ANIMA;
    BondVault public immutable BONDS;

    uint16 public feeBps;
    address public feeRecipient;

    mapping(bytes32 orderHash => bool) public cancelledOrFilled;
    /// @notice Bumped by a maker to invalidate every order they have ever signed at once.
    mapping(address maker => uint256) public makerEpoch;

    struct Rental {
        address tenant;
        uint64 endsAt;
        bool active;
    }

    mapping(uint256 agentId => Rental) public rentalOf;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event OrderFilled(
        bytes32 indexed orderHash,
        uint256 indexed agentId,
        address indexed taker,
        address maker,
        OrderKind kind,
        uint256 price,
        uint256 fee,
        uint256 royalty
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event MakerEpochBumped(address indexed maker, uint256 epoch);
    event RentalEnded(uint256 indexed agentId, address indexed tenant);
    event FeeSet(uint16 feeBps, address recipient);

    error OrderNotStarted(uint64 start);
    error OrderExpired(uint64 expiry);
    error OrderAlreadySettled(bytes32 orderHash);
    error BadSignature(bytes32 orderHash);
    error NotTheTaker(address expected, address actual);
    error MakerNotOwner(uint256 agentId, address maker);
    error AgentStateChanged(uint256 expected, uint256 actual);
    error BrainChanged(bytes32 expectedRoot, bytes32 actualRoot, uint64 expectedEpoch, uint64 actualEpoch);
    error InsufficientCoverage(uint256 required, uint256 available);
    error WrongPayment(uint256 expected, uint256 provided);
    error AgentIsLocked(uint256 agentId);
    error RentalStillActive(uint256 agentId, uint64 endsAt);
    error NoActiveRental(uint256 agentId);
    error BadDuration(uint64 duration);
    error FeeTooHigh(uint16 bps);
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IAnima anima_, BondVault bonds_, address owner_, uint16 feeBps_, address feeRecipient_)
        EIP712("AnimaMarket", "1")
        Ownable(owner_)
    {
        if (address(anima_) == address(0)) revert ZeroAddress();
        ANIMA = anima_;
        BONDS = bonds_;
        _setFee(feeBps_, feeRecipient_);
    }

    function setFee(uint16 feeBps_, address recipient) external onlyOwner {
        _setFee(feeBps_, recipient);
    }

    function _setFee(uint16 feeBps_, address recipient) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        if (feeBps_ != 0 && recipient == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = recipient;
        emit FeeSet(feeBps_, recipient);
    }

    /*//////////////////////////////////////////////////////////////
                                  ORDERS
    //////////////////////////////////////////////////////////////*/

    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    _ORDER_TYPEHASH,
                    uint8(order.kind),
                    order.maker,
                    order.taker,
                    order.agentId,
                    order.payToken,
                    order.price,
                    order.start,
                    order.expiry,
                    order.duration,
                    order.nonce,
                    order.expectedAccountState,
                    order.expectedBrainRoot,
                    order.expectedBrainEpoch,
                    order.minBondCoverage
                )
            )
        );
    }

    /// @notice Cancel one order without spending an on-chain nonce sequence.
    function cancelOrder(Order calldata order) external {
        if (order.maker != msg.sender) revert MakerNotOwner(order.agentId, msg.sender);
        bytes32 orderHash = hashOrder(order);
        cancelledOrFilled[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    /// @notice Invalidate every order this address has signed. The panic button for a leaked
    ///         signing key, which per-order cancellation cannot address.
    function bumpMakerEpoch() external {
        uint256 next;
        unchecked {
            next = ++makerEpoch[msg.sender];
        }
        emit MakerEpochBumped(msg.sender, next);
    }

    /*//////////////////////////////////////////////////////////////
                                   FILL
    //////////////////////////////////////////////////////////////*/

    function fillOrder(Order calldata order, bytes calldata signature, uint256 makerEpoch_)
        external
        payable
        nonReentrant
    {
        bytes32 orderHash = hashOrder(order);

        if (cancelledOrFilled[orderHash]) revert OrderAlreadySettled(orderHash);
        if (block.timestamp < order.start) revert OrderNotStarted(order.start);
        if (block.timestamp > order.expiry) revert OrderExpired(order.expiry);
        if (order.taker != address(0) && order.taker != msg.sender) revert NotTheTaker(order.taker, msg.sender);
        // The epoch is supplied by the taker and checked, rather than read blindly, so a
        // maker bumping their epoch cannot be front-run into cancelling a fill in flight
        // that the taker had already priced.
        if (makerEpoch_ != makerEpoch[order.maker]) revert OrderAlreadySettled(orderHash);
        if (!SignatureChecker.isValidSignatureNow(order.maker, orderHash, signature)) revert BadSignature(orderHash);

        address holder = IERC721(address(ANIMA)).ownerOf(order.agentId);
        if (holder != order.maker) revert MakerNotOwner(order.agentId, order.maker);

        cancelledOrFilled[orderHash] = true;

        _checkIntegrity(order);

        // Deliver the asset BEFORE paying. Paying first hands control to the maker — via an
        // ETH push, or an ERC-777/1363 transfer hook — at a moment when they are still
        // `ownerOf(agentId)`, and an owner can drain the bound account, queue the entire bond
        // for withdrawal to themselves, and wipe the brain. Every integrity check above would
        // have passed on the pre-callback state and the fill would still succeed, so the
        // buyer would receive a hollowed-out agent at the price of a full one. Once the token
        // has moved, the maker is no longer a controller and none of those calls authorise.
        if (order.kind == OrderKind.Sale) {
            IERC721(address(ANIMA)).safeTransferFrom(order.maker, msg.sender, order.agentId);
        } else {
            _startRental(order);
        }

        (uint256 fee, uint256 royalty) = _settlePayment(order);

        emit OrderFilled(orderHash, order.agentId, msg.sender, order.maker, order.kind, order.price, fee, royalty);
    }

    /// @dev The whole point of this contract. See the contract-level note.
    function _checkIntegrity(Order calldata order) private view {
        IAnimaMarketHooks a = IAnimaMarketHooks(address(ANIMA));

        if (order.expectedAccountState != SKIP_STATE_CHECK) {
            address account = a.accountOf(order.agentId);
            // An undeployed account has never executed anything, so its state is zero.
            uint256 actual = account.code.length == 0 ? 0 : IERC6551Account(payable(account)).state();
            if (actual != order.expectedAccountState) revert AgentStateChanged(order.expectedAccountState, actual);
        }

        if (order.expectedBrainRoot != bytes32(0)) {
            bytes32 root = a.brainRoot(order.agentId);
            uint64 epoch = a.brainEpoch(order.agentId);
            if (root != order.expectedBrainRoot || epoch != order.expectedBrainEpoch) {
                revert BrainChanged(order.expectedBrainRoot, root, order.expectedBrainEpoch, epoch);
            }
        }

        if (order.minBondCoverage != 0) {
            uint256 available = BONDS.availableCoverage(order.agentId);
            if (available < order.minBondCoverage) revert InsufficientCoverage(order.minBondCoverage, available);
        }
    }

    function _settlePayment(Order calldata order) private returns (uint256 fee, uint256 royalty) {
        uint256 price = order.price;
        fee = (price * feeBps) / 10_000;

        address royaltyReceiver;
        (royaltyReceiver, royalty) = IERC2981(address(ANIMA)).royaltyInfo(order.agentId, price);
        if (royaltyReceiver == address(0)) royalty = 0;
        // Defensive: a misconfigured collection must never make the seller pay to sell.
        if (fee + royalty > price) {
            royalty = price - fee;
        }
        uint256 toMaker = price - fee - royalty;

        if (order.payToken == address(0)) {
            if (msg.value != price) revert WrongPayment(price, msg.value);
            if (fee != 0) Address.sendValue(payable(feeRecipient), fee);
            if (royalty != 0) Address.sendValue(payable(royaltyReceiver), royalty);
            if (toMaker != 0) Address.sendValue(payable(order.maker), toMaker);
        } else {
            if (msg.value != 0) revert WrongPayment(0, msg.value);
            IERC20 token = IERC20(order.payToken);
            if (fee != 0) token.safeTransferFrom(msg.sender, feeRecipient, fee);
            if (royalty != 0) token.safeTransferFrom(msg.sender, royaltyReceiver, royalty);
            if (toMaker != 0) token.safeTransferFrom(msg.sender, order.maker, toMaker);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 RENTAL
    //////////////////////////////////////////////////////////////*/

    /// @dev A paid lease locks the agent for its term. Without the lock the lessor could sell
    ///      the agent mid-lease and the tenant's paid-for access would evaporate — ERC-4907
    ///      clears `user` on transfer, which is correct for a free lease and a rug for a
    ///      paid one.
    function _startRental(Order calldata order) private {
        if (order.duration == 0) revert BadDuration(order.duration);
        IAnimaMarketHooks a = IAnimaMarketHooks(address(ANIMA));
        if (a.locked(order.agentId)) revert AgentIsLocked(order.agentId);

        uint64 endsAt = uint64(block.timestamp) + order.duration;
        rentalOf[order.agentId] = Rental({tenant: msg.sender, endsAt: endsAt, active: true});

        a.moduleSetUser(order.agentId, msg.sender, endsAt);
        a.lockAgent(order.agentId);
    }

    /// @notice Release an expired lease. Permissionless, because an agent should return to
    ///         its owner's control without needing the tenant's cooperation.
    function endRental(uint256 agentId) external nonReentrant {
        Rental storage r = rentalOf[agentId];
        if (!r.active) revert NoActiveRental(agentId);
        if (block.timestamp < r.endsAt) revert RentalStillActive(agentId, r.endsAt);

        address tenant = r.tenant;
        r.active = false;

        IAnimaMarketHooks a = IAnimaMarketHooks(address(ANIMA));
        a.moduleSetUser(agentId, address(0), 0);
        a.unlockAgent(agentId);

        emit RentalEnded(agentId, tenant);
    }

    /*//////////////////////////////////////////////////////////////
                              QUOTE HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Read the integrity values to pin into an order right now. Front-ends call this
    ///         at quote time and paste the results straight into the signed payload.
    function currentIntegrity(uint256 agentId)
        external
        view
        returns (uint256 accountState, bytes32 root, uint64 epoch, uint256 coverage)
    {
        IAnimaMarketHooks a = IAnimaMarketHooks(address(ANIMA));
        address account = a.accountOf(agentId);
        accountState = account.code.length == 0 ? 0 : IERC6551Account(payable(account)).state();
        root = a.brainRoot(agentId);
        epoch = a.brainEpoch(agentId);
        coverage = BONDS.availableCoverage(agentId);
    }
}
