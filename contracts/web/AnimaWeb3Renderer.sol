// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IAnimaWeb3View {
    function ownerOf(uint256 tokenId) external view returns (address);
    function accountOf(uint256 tokenId) external view returns (address);
    function statusOf(uint256 tokenId) external view returns (uint8);
}

/**
 * @title AnimaWeb3Renderer
 * @notice ERC-4804 manual-mode pages for ANIMA agents.
 * @dev A Web3URL client sends the URL path as raw fallback calldata. The fallback response is an
 *      ABI-encoded string, as required by manual mode. Keeping this separate from the immutable
 *      ANIMA diamond lets an existing collection gain a browser without changing token logic.
 */
contract AnimaWeb3Renderer {
    using Strings for address;
    using Strings for uint256;

    IAnimaWeb3View public immutable ANIMA;

    error ZeroAddress();

    constructor(IAnimaWeb3View anima_) {
        if (address(anima_) == address(0)) revert ZeroAddress();
        ANIMA = anima_;
    }

    /// @notice Selects ERC-4804 manual routing, where the complete path is fallback calldata.
    function resolveMode() external pure returns (bytes32) {
        return bytes32("manual");
    }

    /// @notice Serves `/token/{id}/live`; `/` serves a small usage page.
    fallback(bytes calldata path) external returns (bytes memory) {
        if (path.length == 1 && path[0] == bytes1("/")) return abi.encode(_index());
        (bool valid, uint256 tokenId) = _tokenPath(path);
        if (!valid) return abi.encode(_notFound());

        try ANIMA.ownerOf(tokenId) returns (address owner) {
            return abi.encode(_token(tokenId, owner, ANIMA.accountOf(tokenId), ANIMA.statusOf(tokenId)));
        } catch {
            return abi.encode(_notFound());
        }
    }

    function _tokenPath(bytes calldata path) private pure returns (bool valid, uint256 tokenId) {
        bytes memory prefix = bytes("/token/");
        bytes memory suffix = bytes("/live");
        if (path.length <= prefix.length + suffix.length) return (false, 0);
        for (uint256 i; i < prefix.length; ++i) if (path[i] != prefix[i]) return (false, 0);
        for (uint256 i; i < suffix.length; ++i) {
            if (path[path.length - suffix.length + i] != suffix[i]) return (false, 0);
        }
        uint256 end = path.length - suffix.length;
        for (uint256 i = prefix.length; i < end; ++i) {
            uint8 digit = uint8(path[i]);
            if (digit < 48 || digit > 57) return (false, 0);
            tokenId = tokenId * 10 + digit - 48;
        }
        return (true, tokenId);
    }

    function _index() private view returns (string memory) {
        return string.concat(
            _head("ANIMA Web3"),
            '<main><p class="eyebrow">ANIMA &middot; ONCHAIN</p><h1>Sovereign agents,<br><i>direct from Ethereum.</i></h1>',
            '<p>Open <code>/token/{id}/live</code> to inspect an agent.</p><p class="mono">Collection ',
            address(ANIMA).toHexString(),
            "</p></main></body></html>"
        );
    }

    function _token(uint256 id, address owner, address account, uint8 status) private view returns (string memory) {
        string memory idText = id.toString();
        return string.concat(
            _head(string.concat("ANIMA #", idText)),
            '<main><p class="eyebrow">SOVEREIGN AGENT &middot; ', idText,
            '</p><div class="orb">&#10022;</div><h1>ANIMA <i>#', idText,
            '</i></h1><section><label>OWNER</label><code>', owner.toHexString(),
            '</code><label>ERC-6551 WEB3 ACCOUNT</label><code>', account.toHexString(),
            '</code><label>LIFECYCLE STATUS</label><code>', uint256(status).toString(),
            '</code><label>COLLECTION</label><code>', address(ANIMA).toHexString(),
            '</code></section><p class="foot">Rendered entirely from contract state through ERC-4804.</p>',
            "</main></body></html>"
        );
    }

    function _notFound() private pure returns (string memory) {
        return string.concat(_head("ANIMA - Not found"), '<main><p class="eyebrow">ANIMA</p><h1>Agent not found.</h1>',
            '<p>Use <code>/token/{id}/live</code>.</p></main></body></html>');
    }

    function _head(string memory title) private pure returns (string memory) {
        return string.concat(
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
            "<title>", title,
            '</title><style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07070b;color:#eee9df;font:16px Georgia,serif}body:before{content:"";position:fixed;inset:0;background:radial-gradient(circle at 50% 35%,#6547aa55,transparent 38%)}main{position:relative;width:min(760px,92vw);padding:64px 24px;text-align:center}.eyebrow,label,.mono,.foot,code{font-family:ui-monospace,monospace}.eyebrow,label{letter-spacing:.16em;color:#bda7ed}h1{font-size:clamp(42px,9vw,88px);line-height:.95;margin:24px 0}i{color:#c9b5f5}.orb{font-size:72px;color:#c7a9ff;text-shadow:0 0 38px #986cff;margin:30px}section{display:grid;gap:10px;text-align:left;padding:28px;border:1px solid #ffffff24;background:#ffffff08}label{font-size:11px;margin-top:14px}code{overflow-wrap:anywhere;color:#fff}.foot{color:#898396;margin-top:28px;font-size:12px}</style></head><body>'
        );
    }
}
