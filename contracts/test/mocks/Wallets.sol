// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// A minimal smart-contract wallet: ERC-1271 signatures by its owner key, and calls on the owner's behalf.
contract MockERC1271Wallet is IERC1271 {
    address public immutable owner;
    bool public refuse;

    constructor(address owner_) {
        owner = owner_;
    }

    /// Lets a test make the wallet reject every signature (contract signatures are revocable).
    function setRefuse(bool on) external {
        require(msg.sender == owner, "owner");
        refuse = on;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (!refuse && err == ECDSA.RecoverError.NoError && signer == owner) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// Stands in for the Radbro collection (Ethereum mainnet) in tests: ERC-721 plus the ERC721A-style tokensOfOwner the
/// relay reads. The vault never reads it; holder perks are the referee's choice within the fees captured at lock.
contract MockRadbro is ERC721 {
    mapping(address => uint256[]) private _owned;

    constructor() ERC721("Radbro Webring V2", "RADBROS") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory) {
        return _owned[owner];
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            uint256[] storage list = _owned[from];
            for (uint256 i = 0; i < list.length; i++) {
                if (list[i] == tokenId) {
                    list[i] = list[list.length - 1];
                    list.pop();
                    break;
                }
            }
        }
        if (to != address(0)) _owned[to].push(tokenId);
    }
}
