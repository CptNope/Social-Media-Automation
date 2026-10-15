<?php
/** Settings page: Settings → JAT Connector (administrators only). */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class JAT_Settings {
	const SECRET_OPTION = 'jat_connector_signing_secret';

	public static function register() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_jat_connector_save', array( __CLASS__, 'save' ) );
	}

	public static function menu() {
		add_options_page( 'JAT Connector', 'JAT Connector', 'manage_options', 'jat-connector', array( __CLASS__, 'render' ) );
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$configured = strlen( (string) get_option( self::SECRET_OPTION, '' ) ) >= 32;
		?>
		<div class="wrap">
			<h1>JAT Connector</h1>
			<p>Connects this site to JAT Marketing OS. Paste the signing secret shown when you connected the site in JAT Marketing OS.</p>
			<p><strong>Status:</strong> <?php echo $configured ? 'Signing secret saved.' : 'Not configured.'; ?></p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="jat_connector_save">
				<?php wp_nonce_field( 'jat_connector_save' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="jat_secret">Signing secret</label></th>
						<td><input name="jat_secret" id="jat_secret" type="password" class="regular-text" autocomplete="off" minlength="32" required>
						<p class="description">At least 32 characters. Saving replaces the current secret.</p></td>
					</tr>
				</table>
				<?php submit_button( 'Save secret' ); ?>
			</form>
			<p>Create a dedicated user (Editor role, or Author if it should never publish others' posts) and an Application Password for it under Users → Profile.</p>
		</div>
		<?php
	}

	public static function save() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Not allowed.', 403 );
		}
		check_admin_referer( 'jat_connector_save' );
		$secret = isset( $_POST['jat_secret'] ) ? trim( wp_unslash( (string) $_POST['jat_secret'] ) ) : '';
		if ( strlen( $secret ) < 32 ) {
			wp_die( 'The signing secret must be at least 32 characters.', 400 );
		}
		update_option( self::SECRET_OPTION, $secret, false );
		wp_safe_redirect( admin_url( 'options-general.php?page=jat-connector' ) );
		exit;
	}
}
