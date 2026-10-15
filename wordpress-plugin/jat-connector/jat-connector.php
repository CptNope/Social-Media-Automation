<?php
/**
 * Plugin Name:       JAT Connector
 * Description:       Secure connection between this site and JAT Marketing OS: draft and schedule posts, update SEO titles and descriptions (Yoast SEO, Rank Math, AIOSEO) with one-click rollback.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.0
 * Author:            Jeremy Anderson Tech
 * License:           GPL-2.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'JAT_CONNECTOR_VERSION', '0.1.0' );

require_once __DIR__ . '/includes/class-jat-signature.php';
require_once __DIR__ . '/includes/class-jat-seo.php';
require_once __DIR__ . '/includes/class-jat-rest.php';
require_once __DIR__ . '/includes/class-jat-settings.php';

add_action( 'rest_api_init', array( 'JAT_Rest', 'register' ) );
JAT_Settings::register();

register_uninstall_hook( __FILE__, 'jat_connector_uninstall' );
function jat_connector_uninstall() {
	delete_option( JAT_Settings::SECRET_OPTION );
	delete_option( JAT_Seo::CHANGES_OPTION );
}
