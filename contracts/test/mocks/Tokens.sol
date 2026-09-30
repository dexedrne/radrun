// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Test-only tokens for the vault's token policy (docs/WAGER.md §3.6, §9.1). Each models one behaviour seen on
// launchpads; none of them is ever deployed outside tests.

/// A plain mintable ERC-20 with configurable decimals.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Takes `feeBps` of every transfer (burned), like a taxed launch token.
contract FeeOnTransferToken is MockERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) MockERC20("Taxed", "TAX", 18) {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = value * feeBps / 10_000;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// Charges the sender `feeBps` on top of every transfer (the recipient gets the full value, the sender loses more).
/// Deposits into the vault look exact; the vault's own payouts would cost it more than it pays.
contract SenderTaxToken is MockERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) MockERC20("SenderTax", "STX", 18) {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            super._update(from, address(0), value * feeBps / 10_000);
        }
        super._update(from, to, value);
    }
}

/// Reverts every transfer to or from a blacklisted address (an owner-controlled blacklist).
contract BlacklistToken is MockERC20 {
    mapping(address => bool) public blacklisted;

    error Blacklisted(address account);

    constructor() MockERC20("Blacklist", "BLK", 18) {}

    function setBlacklisted(address account, bool on) external {
        blacklisted[account] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blacklisted[from]) revert Blacklisted(from);
        if (blacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}

/// Reverts every transfer while paused (mints still work).
contract PausableToken is MockERC20 {
    bool public paused;

    error TokenPaused();

    constructor() MockERC20("Pausable", "PAU", 18) {}

    function setPaused(bool on) external {
        paused = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused && from != address(0)) revert TokenPaused();
        super._update(from, to, value);
    }
}

/// Every wallet transfer reverts until unlock() (a token locked until its launch graduates).
contract GraduationLockedToken is MockERC20 {
    bool public unlocked;

    error TransfersLockedUntilGraduation();

    constructor() MockERC20("Locked", "LCK", 18) {}

    function unlock() external {
        unlocked = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!unlocked && from != address(0)) revert TransfersLockedUntilGraduation();
        super._update(from, to, value);
    }
}

/// Max-transaction and max-wallet limits (early-launch anti-bot windows). Exempt addresses skip the wallet limit.
contract MaxWalletToken is MockERC20 {
    uint256 public maxTx;
    uint256 public maxWallet;
    mapping(address => bool) public exempt;

    error MaxTx();
    error MaxWallet();

    constructor(uint256 maxTx_, uint256 maxWallet_) MockERC20("Limited", "LIM", 18) {
        maxTx = maxTx_;
        maxWallet = maxWallet_;
    }

    function setExempt(address account, bool on) external {
        exempt[account] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            if (value > maxTx) revert MaxTx();
            if (!exempt[to] && balanceOf(to) + value > maxWallet) revert MaxWallet();
        }
        super._update(from, to, value);
    }
}

/// Balances are shares times an index the test moves up or down (positive / negative rebasing).
contract RebasingToken {
    string public constant name = "Rebase";
    string public constant symbol = "REB";
    uint8 public constant decimals = 18;
    uint256 public index = 1e18;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function rebase(uint256 newIndex) external {
        index = newIndex;
    }

    function totalSupply() external view returns (uint256) {
        return totalShares * index / 1e18;
    }

    function balanceOf(address a) public view returns (uint256) {
        return sharesOf[a] * index / 1e18;
    }

    function mint(address to, uint256 amount) external {
        uint256 shares = amount * 1e18 / index;
        sharesOf[to] += shares;
        totalShares += shares;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 shares = amount * 1e18 / index;
        sharesOf[from] -= shares;
        sharesOf[to] += shares;
        emit Transfer(from, to, amount);
    }
}

/// Returns nothing from transfer / transferFrom / approve (the USDT shape); SafeERC20 must cope.
contract NoReturnToken {
    string public constant name = "NoReturn";
    string public constant symbol = "NRT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Returns false instead of reverting on a failed transfer; SafeERC20 must treat that as a failure.
contract FalseReturnToken is MockERC20 {
    bool public fail;

    constructor() MockERC20("False", "FLS", 18) {}

    function setFail(bool on) external {
        fail = on;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (fail) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (fail) return false;
        return super.transferFrom(from, to, amount);
    }
}

/// Moves the tokens, then calls a hook on the recipient or sender (an ERC-777-style callback) so a test can try to
/// re-enter the vault mid-transfer.
contract HookToken is MockERC20 {
    address public hook;

    constructor() MockERC20("Hook", "HOOK", 18) {}

    function setHook(address hook_) external {
        hook = hook_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hook != address(0) && from != address(0)) {
            (bool ok, bytes memory ret) = hook.call(abi.encodeWithSignature("onTokenTransfer()"));
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}

/// An ERC-20 with no decimals() at all (the vault constructor refuses it).
contract NoDecimalsToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
}
