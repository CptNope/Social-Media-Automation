<?php
// Run: php wordpress-plugin/jat-connector/tests/test-signature.php
define( 'JAT_TESTING', true );
require __DIR__ . '/../includes/class-jat-signature.php';

$failures = 0;
function check( $name, $cond ) {
	global $failures;
	echo ( $cond ? 'ok' : 'FAIL' ) . " - $name\n";
	if ( ! $cond ) {
		$failures++;
	}
}

$secret = str_repeat( 'k', 40 );
$now    = 1760000000;
$seen   = array();
$store  = function ( $nonce ) use ( &$seen ) {
	if ( isset( $seen[ $nonce ] ) ) {
		return true;
	}
	$seen[ $nonce ] = true;
	return false;
};
$nonce = str_repeat( 'a', 32 );
$body  = '{"title":"Hi"}';
$sig   = JAT_Signature::sign( $secret, 'POST', '/jat/v1/posts', $now, $nonce, $body );

check( 'valid signature passes', true === JAT_Signature::verify( $secret, 'POST', '/jat/v1/posts', (string) $now, $nonce, $body, $sig, $now, $store ) );
check( 'replayed nonce is rejected', 'jat_signature_replayed' === JAT_Signature::verify( $secret, 'POST', '/jat/v1/posts', (string) $now, $nonce, $body, $sig, $now, $store ) );
$n2 = str_repeat( 'b', 32 );
$s2 = JAT_Signature::sign( $secret, 'POST', '/jat/v1/posts', $now, $n2, $body );
check( 'tampered body is rejected', 'jat_signature_invalid' === JAT_Signature::verify( $secret, 'POST', '/jat/v1/posts', (string) $now, $n2, '{"title":"Evil"}', $s2, $now, $store ) );
check( 'other route is rejected', 'jat_signature_invalid' === JAT_Signature::verify( $secret, 'POST', '/jat/v1/changes/x/rollback', (string) $now, $n2, $body, $s2, $now, $store ) );
check( 'stale timestamp is rejected', 'jat_signature_stale' === JAT_Signature::verify( $secret, 'POST', '/jat/v1/posts', (string) ( $now - 301 ), $n2, $body, $s2, $now, $store ) );
check( 'short secret means not configured', 'jat_signature_not_configured' === JAT_Signature::verify( 'short', 'POST', '/jat/v1/posts', (string) $now, $n2, $body, $s2, $now, $store ) );
check( 'missing signature', 'jat_signature_missing' === JAT_Signature::verify( $secret, 'POST', '/jat/v1/posts', (string) $now, $n2, $body, null, $now, $store ) );
check( 'invalid signature does not burn the nonce', ! isset( $seen[ $n2 ] ) );

// Cross-language: verify a signature produced by the TypeScript client, passed via env.
$ts_sig = getenv( 'JAT_TS_SIGNATURE' );
if ( $ts_sig ) {
	$fresh = function () {
		return false;
	};
	check(
		'signature from the TypeScript client verifies',
		true === JAT_Signature::verify( getenv( 'JAT_TS_SECRET' ), getenv( 'JAT_TS_METHOD' ), getenv( 'JAT_TS_ROUTE' ), getenv( 'JAT_TS_TIMESTAMP' ), getenv( 'JAT_TS_NONCE' ), getenv( 'JAT_TS_BODY' ), $ts_sig, (int) getenv( 'JAT_TS_TIMESTAMP' ), $fresh )
	);
}

exit( $failures ? 1 : 0 );
