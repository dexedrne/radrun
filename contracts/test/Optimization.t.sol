// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {GameVault} from "../src/GameVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGameVault, OUTCOME_WIN, OUTCOME_VOID} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockERC20} from "./mocks/Tokens.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// Boundary coverage for unchecked bucket transfers and both encodings of the same signed authorization.
contract OptimizationTest is VaultTestBase {
    function _compact(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 vs) = vm.signCompact(pk, hash);
        return abi.encodePacked(r, vs);
    }

    function testFuzz_compactLifecycle(uint128 amount, bool mutual, bool voided, bool wallet) public {
        amount = uint128(bound(amount, 1, MAX_STAKE));
        _deposit(alice, amount);
        _deposit(bob, amount);
        IGameVault.SessionAuth memory auth = _auth(alice, aliceKey, amount, amount, uint64(block.timestamp + 1 days));
        vault.openSession(auth, _compact(alicePk, _hashAuth(auth)));
        _openSession(bobPk, bobKey, amount, amount);
        bytes32 id = _mid(alice, keccak256("compact"));
        IGameVault.Entry memory a = _entry(id, alice, bob, amount);
        IGameVault.Entry memory b = _entry(id, bob, alice, amount);
        bytes memory sigA = _compact(wallet ? alicePk : aliceKeyPk, _hashEntry(a));
        bytes memory sigB = _compact(wallet ? bobPk : bobKeyPk, _hashEntry(b));
        vault.lock(a, sigA, b, sigB);
        // Re-encoding never bypasses match-id replay protection.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, id));
        vault.lock(a, _sign(wallet ? alicePk : aliceKeyPk, _hashEntry(a)), b, sigB);
        IGameVault.Result memory r =
            _result(id, voided ? OUTCOME_VOID : OUTCOME_WIN, voided ? address(0) : alice, voided ? 0 : FEE);
        if (mutual) vault.settleMutual(r, _compact(alicePk, _hashResult(r)), _compact(bobPk, _hashResult(r)));
        else vault.settle(r, _compact(refereePk, _hashResult(r)));
        _assertBooks(_players());
        assertEq(vault.lockedOf(alice) + vault.lockedOf(bob), 0);
        uint256 fee = voided ? 0 : 2 * uint256(amount) * FEE / 10_000;
        assertEq(vault.houseAccrued(), fee);
        assertEq(vault.freeOf(alice), voided ? amount : 2 * uint256(amount) - fee);
        assertEq(vault.sessionOf(alice).used, voided || wallet ? 0 : amount);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, id));
        vault.settle(r, _compact(refereePk, _hashResult(r)));
    }

    function testFuzz_bucketBoundary(uint128 stake, uint16 fee, uint8 exit) public {
        MockERC20 t = new MockERC20("Boundary", "BOUND", 18);
        token = IERC20(address(t));
        vault = _newVault(address(t));
        vm.startPrank(owner);
        vault.setCaps(type(uint128).max, type(uint128).max);
        fee = uint16(bound(fee, 0, 500));
        vault.setHouseFees(fee, fee);
        vm.stopPrank();
        stake = uint128(bound(stake, 1, type(uint128).max / 2));
        t.mint(address(this), type(uint128).max);
        // Exact accounting limit, including spare free funds at the eventual winner.
        _deposit(alice, uint256(type(uint128).max) - stake);
        _deposit(bob, stake);
        bytes32 id = _mid(alice, keccak256("boundary"));
        IGameVault.Entry memory a = _entry(id, alice, bob, stake);
        IGameVault.Entry memory b = _entry(id, bob, alice, stake);
        vault.lock(a, _signEntry(alicePk, a), b, _signEntry(bobPk, b));
        if (exit % 3 == 0) {
            _settle(id, alice, fee);
            uint256 charged = 2 * uint256(stake) * fee / 10_000;
            assertEq(vault.freeOf(alice), uint256(type(uint128).max) - charged);
        } else if (exit % 3 == 1) {
            vm.warp(block.timestamp + WINDOW + 1);
            vm.prank(alice);
            vault.reclaim(id);
            vault.refundExpired(id); // already released side cannot be released twice
            assertEq(vault.freeOf(alice), uint256(type(uint128).max) - stake);
        } else {
            IGameVault.Result memory r = _result(id, OUTCOME_VOID, address(0), 0);
            vault.settle(r, _signResult(refereePk, r));
            assertEq(vault.freeOf(bob), stake);
        }
        _assertBooks(_players());
        assertEq(vault.totalLiabilities(), type(uint128).max);
    }

    function test_compactDomainBindingAndNonceReplay() public {
        IGameVault.SessionAuth memory auth = _auth(alice, aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        bytes memory sig = _compact(alicePk, _hashAuth(auth));
        GameVault other = _newVault(address(token));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        other.openSession(auth, sig);
        uint256 chain = vm.getChainId();
        vm.chainId(46630);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(auth, sig);
        vm.chainId(chain);
        vault.openSession(auth, sig);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadNonce.selector, uint64(1), uint64(0)));
        vault.openSession(auth, _sign(alicePk, _hashAuth(auth)));
    }

    function test_compactHighSAndZeroRejected() public {
        IGameVault.SessionAuth memory auth = _auth(alice, aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        // This s is below 2^255 (so representable in ERC-2098), but above the secp256k1 half order.
        bytes memory highS = abi.encodePacked(
            bytes32(uint256(1)), bytes32(uint256(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff))
        );
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(auth, highS);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(auth, new bytes(64));
    }

    function test_contractWalletReceivesOriginal64Bytes() public {
        OpaqueWallet w = new OpaqueWallet();
        IGameVault.SessionAuth memory auth =
            _auth(address(w), aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        bytes memory opaque = new bytes(64);
        w.allow(_hashAuth(auth), keccak256(opaque));
        vault.openSession(auth, opaque);
        assertEq(vault.sessionOf(address(w)).key, aliceKey);
    }
}

contract OpaqueWallet is IERC1271 {
    bytes32 internal digest;
    bytes32 internal signatureHash;

    function allow(bytes32 d, bytes32 s) external {
        digest = d;
        signatureHash = s;
    }

    function isValidSignature(bytes32 d, bytes calldata s) external view returns (bytes4) {
        return d == digest && keccak256(s) == signatureHash ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
