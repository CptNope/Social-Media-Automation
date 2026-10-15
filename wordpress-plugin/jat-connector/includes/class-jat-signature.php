<?php
/**
 * Request signature verification (pure PHP, no WordPress dependencies, unit-tested).
 *
 * signature = hex( HMAC-SHA256( secret, METHOD "\n" ROUTE "\n" TIMESTAMP "\n" NONCE "\n" hex(SHA-256(body)) ) )
 * Must match packages/integrations/src/wordpress.ts (a cross-language test checks this).
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'JAT_TESTING' ) ) {
	exit;
}

final class JAT_Signature {
	const MAX_SKEW_SECONDS = 300;

	/**
	 * @param callable $nonce_seen function(string $nonce): bool — returns true if the nonce was
	 *                             already used, and records it otherwise.
	 * @return true|string True when valid, otherwise an error code.
	 */
	public static function verify( $secret, $method, $route, $timestamp, $nonce, $body, $signature, $now, $nonce_seen ) {
		if ( ! is_string( $secret ) || strlen( $secret ) < 32 ) {
			return 'jat_signature_not_configured';
		}
		if ( ! is_string( $signature ) || ! preg_match( '/^[0-9a-f]{64}$/', $signature ) ) {
			return 'jat_signature_missing';
		}
		if ( ! is_string( $nonce ) || ! preg_match( '/^[0-9a-f]{16,64}$/', $nonce ) ) {
			return 'jat_signature_bad_nonce';
		}
		if ( ! is_numeric( $timestamp ) || abs( (int) $now - (int) $timestamp ) > self::MAX_SKEW_SECONDS ) {
			return 'jat_signature_stale';
		}
		$expected = self::sign( $secret, $method, $route, (int) $timestamp, $nonce, (string) $body );
		if ( ! hash_equals( $expected, $signature ) ) {
			return 'jat_signature_invalid';
		}
		// Check the nonce only after the signature, so unsigned requests can't fill the store.
		if ( call_user_func( $nonce_seen, $nonce ) ) {
			return 'jat_signature_replayed';
		}
		return true;
	}

	public static function sign( $secret, $method, $route, $timestamp, $nonce, $body ) {
		$payload = strtoupper( $method ) . "\n" . $route . "\n" . $timestamp . "\n" . $nonce . "\n" . hash( 'sha256', $body );
		return hash_hmac( 'sha256', $payload, $secret );
	}
}
